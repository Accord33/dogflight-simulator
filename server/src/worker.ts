import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  GAME_ROOM: DurableObjectNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS設定
app.use('/*', cors())

// ルートアクセス時の説明
app.get('/', (c) => {
  return c.json({
    service: 'Ace Wing Online WebSocket Server',
    status: 'running',
    endpoints: {
      websocket: '/ws',
      documentation: 'Connect via WebSocket to /ws endpoint'
    }
  })
})

// WebSocket接続エンドポイント
app.get('/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade')
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426)
  }

  // URLパラメータからroom指定がある場合はそれを使用、なければDEFAULT
  // matchmakeの場合は後でルームを決定する
  const roomCode = c.req.query('room') || 'LOBBY'
  const id = c.env.GAME_ROOM.idFromName(roomCode)
  const stub = c.env.GAME_ROOM.get(id)

  return stub.fetch(c.req.raw)
})

export default app

// Durable Object: ゲームルームの管理
export class GameRoom {
  state: DurableObjectState
  sessions: Map<string, WebSocket>
  mode: string | null
  stage: string | null
  maxPlayers: number
  matchQueue: Array<{ ws: WebSocket; mode: string; stage: string; id: string }>

  constructor(state: DurableObjectState) {
    this.state = state
    this.sessions = new Map()
    this.mode = null
    this.stage = null
    this.maxPlayers = 2
    this.matchQueue = []
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.state.acceptWebSocket(server)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(message as string)
      
      // クライアントIDを取得または生成
      let clientId = this.getClientId(ws)
      if (!clientId) {
        clientId = crypto.randomUUID()
        this.sessions.set(clientId, ws)
      }

      switch (msg.type) {
        case 'join':
          this.handleJoin(ws, clientId, msg)
          break
        case 'matchmake':
          this.handleMatchmake(ws, clientId, msg)
          break
        case 'state':
          this.broadcast({ ...msg, playerId: clientId }, clientId)
          break
        case 'action':
          this.broadcast({ ...msg, playerId: clientId }, clientId)
          break
        case 'hit':
          this.broadcast({ ...msg, playerId: clientId })
          break
        case 'enemySnapshot':
          const isHost = this.isHost(clientId)
          if (isHost) {
            this.broadcast({ ...msg, playerId: clientId }, clientId)
          }
          break
        default:
          break
      }
    } catch (e) {
      console.error('WebSocket message error:', e)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const clientId = this.getClientId(ws)
    if (clientId) {
      // broadcastを先に実行してから削除
      this.broadcast({ type: 'player-leave', playerId: clientId, count: this.sessions.size - 1 }, clientId)
      this.sessions.delete(clientId)

      // ホスト権限の再割り当て
      if (this.sessions.size > 0) {
        const newHostId = Array.from(this.sessions.keys())[0]
        const newHostWs = this.sessions.get(newHostId)
        if (newHostWs && newHostWs.readyState === WebSocket.READY_STATE_OPEN) {
          try {
            newHostWs.send(JSON.stringify({ type: 'host-grant' }))
          } catch (e) {
            console.error('Failed to send host-grant:', e)
          }
        }
      }
    }
  }

  private handleJoin(ws: WebSocket, clientId: string, msg: any) {
    if (this.sessions.size >= this.maxPlayers) {
      ws.send(JSON.stringify({ type: 'error', message: 'Room full' }))
      ws.close(1000, 'Room full')
      return
    }

    const mode = msg.mode || 'ONLINE_VS'
    const stage = msg.stage || 'OCEAN'

    if (this.mode && this.mode !== mode) {
      ws.send(JSON.stringify({ type: 'error', message: 'Room mode mismatch' }))
      ws.close(1000, 'Room mode mismatch')
      return
    }

    this.mode = this.mode || mode
    this.stage = this.stage || stage
    this.sessions.set(clientId, ws)

    const isHost = this.sessions.size === 1

    ws.send(JSON.stringify({
      type: 'welcome',
      playerId: clientId,
      isHost,
      room: msg.room || 'DEFAULT',
      mode: this.mode,
      stage: this.stage,
      count: this.sessions.size
    }))

    this.broadcast({ type: 'player-join', playerId: clientId, count: this.sessions.size }, clientId)
  }

  private handleMatchmake(ws: WebSocket, clientId: string, msg: any) {
    const mode = msg.mode || 'ONLINE_VS'
    const stage = msg.stage || 'OCEAN'

    // 同じモードを待っているプレイヤーを検索
    const opponentIndex = this.matchQueue.findIndex(entry => 
      entry.mode === mode && entry.ws.readyState === WebSocket.READY_STATE_OPEN
    )
    
    if (opponentIndex >= 0) {
      const opponent = this.matchQueue.splice(opponentIndex, 1)[0]
      const roomCode = this.generateRoomCode()
      
      // 両方をセッションに追加
      this.mode = mode
      this.stage = stage
      this.sessions.set(opponent.id, opponent.ws)
      this.sessions.set(clientId, ws)
      
      // Welcome送信
      opponent.ws.send(JSON.stringify({
        type: 'welcome',
        playerId: opponent.id,
        isHost: true,
        room: roomCode,
        mode: this.mode,
        stage: this.stage,
        count: 2
      }))
      
      ws.send(JSON.stringify({
        type: 'welcome',
        playerId: clientId,
        isHost: false,
        room: roomCode,
        mode: this.mode,
        stage: this.stage,
        count: 2
      }))
      
      // 相互にjoinを通知
      opponent.ws.send(JSON.stringify({ type: 'player-join', playerId: clientId, count: 2 }))
      ws.send(JSON.stringify({ type: 'player-join', playerId: opponent.id, count: 2 }))
    } else {
      this.matchQueue.push({ ws, mode, stage, id: clientId })
      ws.send(JSON.stringify({ type: 'matching', mode, stage }))
    }
  }

  private broadcast(data: any, exceptId?: string) {
    const payload = JSON.stringify(data)
    for (const [id, ws] of this.sessions.entries()) {
      if (id !== exceptId && ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(payload)
        } catch (e) {
          console.error('Broadcast error:', e)
        }
      }
    }
  }

  private getClientId(ws: WebSocket): string | undefined {
    for (const [id, session] of this.sessions.entries()) {
      if (session === ws) return id
    }
    return undefined
  }

  private isHost(clientId: string): boolean {
    return Array.from(this.sessions.keys())[0] === clientId
  }

  private generateRoomCode(): string {
    return Math.random().toString(36).slice(2, 7).toUpperCase()
  }
}
