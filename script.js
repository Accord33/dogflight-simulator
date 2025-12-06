const CONFIG = {
    playerSpeedMin: 0.3, playerSpeedMax: 1.2,
    turnSpeed: 0.015,
    bulletSpeed: 6.0, 
    missileSpeedMultiplier: 1.3, // Missiles move at ~1.3x the player's current speed
    missileCapacity: 20,
    missileReloadTimeMs: 30000, // 30s reload when missiles are depleted
    enemySpeed: 0.5,
    seaSize: 2000,
    fireRate: 80 // ms between shots
};

const GAME_MODES = { LOCAL: 'LOCAL', ONLINE_VS: 'ONLINE_VS', ONLINE_COOP: 'ONLINE_COOP' };
const NET_DEFAULT_URL = 'ws://localhost:3001';

// Globals
let scene, camera, renderer;
let player, environmentMesh, obstacles = [];
let bullets = [], missiles = [], enemies = [], particles = [];
let keys = { w: false, s: false, a: false, d: false, space: false };
let mouse = { x: 0, y: 0, isDown: false };
let enemyIdCounter = 0;

let isPlaying = false;
let currentStage = 'OCEAN';
let gameMode = GAME_MODES.LOCAL;
let isNetHost = false;
let netClient = null;
let netPlayerId = null;
let netRoom = null;
let remotePlayers = {};
let lastNetStateSent = 0;
let pendingEnemySnapshot = null;
let lastEnemySnapshotTime = 0;
let lives = 3;
let waitingForOpponent = false;
let pendingStage = null;
const RADAR_RANGE = 500; // meters
let score = 0, armor = 100, missileCount = CONFIG.missileCapacity;
let lastShotTime = 0, lastMissileTime = 0, missileReloadEndTime = null;
let muzzleFlashLight;
const scoreListKey = 'aceWingHighScores';

// UI Refs
const ui = {
    score: document.getElementById('score-val'),
    hpBar: document.getElementById('hp-bar-fill'),
    missile: document.getElementById('missile-val'),
    radar: document.getElementById('radar-container'),
    alert: document.getElementById('missile-alert'),
    msg: document.getElementById('message-area'),
    menu: document.getElementById('menu-overlay'),
    gameOverMsg: document.getElementById('game-over-msg'),
    highScoreList: document.getElementById('highscore-list'),
    markersLayer: document.getElementById('markers-layer'),
    netBadge: document.getElementById('net-badge'),
    lives: document.getElementById('lives-val'),
    livesPanel: document.getElementById('lives-panel'),
    waitingText: document.getElementById('waiting-text')
};
const screens = {
    title: document.getElementById('title-screen'),
    world: document.getElementById('world-screen'),
    result: document.getElementById('result-screen'),
    online: document.getElementById('online-screen'),
    waiting: document.getElementById('waiting-screen')
};
const menuActions = {
    enterWorld: document.getElementById('enter-world-select'),
    titleToWorld: document.getElementById('title-to-world'),
    titleToOnline: document.getElementById('title-to-online'),
    onlineToTitle: document.getElementById('online-to-title'),
    worldToTitle: document.getElementById('world-to-title'),
    retry: document.getElementById('retry-btn'),
    resultToWorld: document.getElementById('result-to-world'),
    resultToTitle: document.getElementById('result-to-title'),
    onlineStart: document.getElementById('online-start'),
    onlineRandom: document.getElementById('online-random'),
    cancelWait: document.getElementById('cancel-wait')
};
const resultUI = {
    score: document.getElementById('result-score'),
    rank: document.getElementById('result-rank')
};
const onlineUI = {
    roomCode: document.getElementById('room-code'),
    mode: document.getElementById('mode-select'),
    stage: document.getElementById('stage-select'),
    statusText: document.getElementById('net-status-text'),
    roomText: document.getElementById('net-room-text')
};

function setScreen(target) {
    if(target === 'playing') {
        ui.menu.style.display = 'none';
        Object.values(screens).forEach(s => s.classList.remove('active'));
        return;
    }
    ui.menu.style.display = 'flex';
    Object.entries(screens).forEach(([name, el]) => el.classList.toggle('active', name === target));
}

function getRank(s) {
    const tiers = [
        { min: 3000, rank: 'SSS' },
        { min: 2000, rank: 'SS' },
        { min: 1200, rank: 'S' },
        { min: 800, rank: 'A' },
        { min: 500, rank: 'B' },
        { min: 200, rank: 'C' },
        { min: 0, rank: 'D' }
    ];
    return tiers.find(t => s >= t.min)?.rank || 'D';
}

function init() {
    const container = document.getElementById('canvas-container');
    
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Controls
    document.addEventListener('keydown', (e) => onKey(e, true));
    document.addEventListener('keyup', (e) => onKey(e, false));
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', (e) => { if(e.button===0) mouse.isDown = true; });
    document.addEventListener('mouseup', (e) => { if(e.button===0) mouse.isDown = false; });
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); fireMissile(player, false); });
    window.addEventListener('resize', onResize);

    updateHighScoreDisplay();

    // Menu bindings
    if(menuActions.enterWorld) menuActions.enterWorld.addEventListener('click', () => setScreen('world'));
    if(menuActions.titleToWorld) menuActions.titleToWorld.addEventListener('click', () => setScreen('world'));
    if(menuActions.titleToOnline) menuActions.titleToOnline.addEventListener('click', () => setScreen('online'));
    if(menuActions.onlineToTitle) menuActions.onlineToTitle.addEventListener('click', () => setScreen('title'));
    if(menuActions.worldToTitle) menuActions.worldToTitle.addEventListener('click', () => setScreen('title'));
    if(menuActions.retry) menuActions.retry.addEventListener('click', () => startGame(currentStage, { mode: gameMode, isHost: isNetHost, roomCode: netRoom }));
    if(menuActions.resultToWorld) menuActions.resultToWorld.addEventListener('click', () => setScreen('world'));
    if(menuActions.resultToTitle) menuActions.resultToTitle.addEventListener('click', () => setScreen('title'));
    if(menuActions.onlineStart) menuActions.onlineStart.addEventListener('click', () => handleOnlineStart());
    if(menuActions.onlineRandom) menuActions.onlineRandom.addEventListener('click', () => handleRandomMatch());
    if(menuActions.cancelWait) menuActions.cancelWait.addEventListener('click', () => cancelWaiting());
    document.querySelectorAll('[data-stage]').forEach(btn => {
        btn.addEventListener('click', () => startGame(btn.dataset.stage, { mode: GAME_MODES.LOCAL }));
    });

    setupDefaultRoomCode();
    setNetStatus('OFFLINE', 'offline');
    setScreen('title');
}

function startGame(stage, opts = {}) {
    currentStage = stage;
    gameMode = opts.mode || GAME_MODES.LOCAL;
    isNetHost = !!opts.isHost;
    netRoom = opts.roomCode || netRoom;
    isPlaying = true;
    score = 0; armor = 100; missileCount = CONFIG.missileCapacity; missileReloadEndTime = null;
    lives = (gameMode === GAME_MODES.ONLINE_VS) ? 3 : 1;
    lastNetStateSent = 0; pendingEnemySnapshot = null; lastEnemySnapshotTime = 0;
    
    while(scene.children.length > 0) scene.remove(scene.children[0]);
    bullets = []; missiles = []; enemies = []; particles = []; obstacles = [];
    ui.markersLayer.innerHTML = ''; 

    setupEnvironment(stage);
    
    player = createPlayer({ bodyColor: 0x607d8b, cockpitColor: 0xffd54f });
    scene.add(player.mesh);
    player.mesh.position.set(0, 50, 0);

    // Muzzle Flash Effect Setup
    muzzleFlashLight = new THREE.PointLight(0xffffaa, 0, 20); // Initially 0 intensity
    player.mesh.add(muzzleFlashLight);
    muzzleFlashLight.position.set(0, 0, -3); // Near noise

    updateUI();
    setScreen('playing');
    ui.gameOverMsg.style.display = 'none';

    if(gameMode !== GAME_MODES.ONLINE_VS && (gameMode !== GAME_MODES.ONLINE_COOP || isNetHost)) {
        for(let i=0; i<10; i++) spawnEnemy();
    }
    
    animate();
}

function gameOver() {
    if(!isPlaying) return;
    isPlaying = false;
    saveScore(score);
    updateHighScoreDisplay();
    
    // Find rank
    let scores = JSON.parse(localStorage.getItem(scoreListKey) || '[]');
    let rank = scores.indexOf(score) + 1;
    let rankText = rank > 0 ? `RANK ${rank}` : 'NOT RANKED';

    // Update game over message with score and rank
    ui.gameOverMsg.innerHTML = `
        <div>MISSION FAILED</div>
        <div style="font-size: 1.5rem; margin-top: 15px; color: #ffffff;">SCORE: ${score}</div>
        <div style="font-size: 1.5rem; margin-top: 5px; color: #aaddff;">${rankText}</div>
    `;
    ui.gameOverMsg.style.display = 'none';
    showResult();
}

function showResult() {
    resultUI.score.innerText = score;
    const r = getRank(score);
    resultUI.rank.innerText = r;
    resultUI.rank.className = 'rank-badge';
    resultUI.rank.classList.add(`rank-${r}`);
    setScreen('result');
}

function setupDefaultRoomCode() {
    if(!onlineUI.roomCode) return;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for(let i=0; i<4; i++) code += alphabet[Math.floor(Math.random()*alphabet.length)];
    onlineUI.roomCode.value = code;
}

async function handleOnlineStart() {
    if(!onlineUI.roomCode || !onlineUI.mode || !onlineUI.stage) return;
    const room = (onlineUI.roomCode.value || '').toUpperCase().trim() || 'ACE';
    const mode = onlineUI.mode.value;
    const stage = onlineUI.stage.value;
    try {
        setNetStatus(`CONNECTING ${room}`, 'pending');
        showWaiting(`CONNECTING ${room}...`);
        if(!netClient) netClient = new NetClient(NET_DEFAULT_URL);
        pendingStage = stage;
        const info = await netClient.connect({ room, mode, stage, random: false });
        handleWelcome(info);
    } catch(err) {
        console.error(err);
        setNetStatus('FAILED', 'offline');
        showMessage('CONNECT FAILED', 1200);
        setScreen('online');
        waitingForOpponent = false;
    }
}

async function handleRandomMatch() {
    if(!onlineUI.mode || !onlineUI.stage) return;
    const mode = onlineUI.mode.value;
    const stage = onlineUI.stage.value;
    try {
        setNetStatus('MATCHING...', 'pending');
        showWaiting('MATCHING...');
        if(!netClient) netClient = new NetClient(NET_DEFAULT_URL);
        pendingStage = stage;
        const info = await netClient.connect({ mode, stage, random: true });
        handleWelcome(info);
    } catch(err) {
        console.error(err);
        setNetStatus('FAILED', 'offline');
        showMessage('MATCH FAILED', 1200);
        setScreen('online');
        waitingForOpponent = false;
    }
}

function setNetStatus(text, state) {
    if(onlineUI.statusText) onlineUI.statusText.innerText = text;
    if(onlineUI.roomText) onlineUI.roomText.innerText = `ROOM ${netRoom || '--'}`;
    if(ui.netBadge) {
        ui.netBadge.innerText = (state === 'online') ? text : 'OFFLINE';
        ui.netBadge.style.borderColor = state === 'online' ? 'rgba(0,255,140,0.7)' : 'rgba(255,255,255,0.3)';
        ui.netBadge.style.boxShadow = state === 'online' ? '0 0 12px rgba(0,255,140,0.5)' : '0 0 12px rgba(255,255,255,0.2)';
    }
}

function showWaiting(text) {
    if(ui.waitingText) ui.waitingText.innerText = text;
    setScreen('waiting');
    waitingForOpponent = true;
}

function cancelWaiting() {
    waitingForOpponent = false;
    if(netClient) netClient.disconnect();
    setNetStatus('OFFLINE', 'offline');
    setScreen('online');
}

function sendNet(type, payload) {
    if(netClient && netClient.isOpen()) {
        netClient.send(type, payload);
    }
}

class NetClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
    }
    isOpen() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
    disconnect() {
        if(this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    connect({ room, mode, stage, random }) {
        return new Promise((resolve, reject) => {
            if(this.ws) {
                this.ws.close();
            }
            this.ws = new WebSocket(this.url);
            const ws = this.ws;
            let welcomed = false;
            ws.onopen = () => {
                if(random) ws.send(JSON.stringify({ type: 'matchmake', mode, stage }));
                else ws.send(JSON.stringify({ type: 'join', room, mode, stage }));
            };
            ws.onmessage = (ev) => {
                let msg;
                try { msg = JSON.parse(ev.data); } catch(e) { return; }
                if(msg.type === 'welcome') {
                    welcomed = true;
                    resolve(msg);
                    return;
                }
                this.routeMessage(msg);
            };
            ws.onerror = (e) => {
                if(!welcomed) reject(e);
            };
            ws.onclose = () => {
                if(!welcomed) reject(new Error('Disconnected'));
                setNetStatus('OFFLINE', 'offline');
                waitingForOpponent = false;
                if(screens.waiting && screens.waiting.classList.contains('active')) setScreen('online');
            };
        });
    }
    send(type, payload) {
        if(!this.isOpen()) return;
        this.ws.send(JSON.stringify({ ...payload, type }));
    }
    routeMessage(msg) {
        switch(msg.type) {
            case 'state': applyRemoteState(msg); break;
            case 'action': handleRemoteAction(msg); break;
            case 'hit': handleRemoteHit(msg); break;
            case 'player-join':
                showMessage('ALLY CONNECTED', 800);
                if(waitingForOpponent && msg.count >= 2) startMatchFromNet();
                break;
            case 'player-leave':
                removeRemotePlayer(msg.playerId);
                break;
            case 'host-grant':
                isNetHost = true;
                if(gameMode === GAME_MODES.ONLINE_COOP && enemies.length === 0) {
                    for(let i=0; i<10; i++) spawnEnemy();
                }
                break;
            case 'matching':
                showWaiting('MATCHING...');
                break;
            case 'enemySnapshot': applyEnemySnapshot(msg); break;
            case 'error':
                showMessage(msg.message || 'NET ERROR', 1200);
                setNetStatus('ERROR', 'offline');
                break;
            default: break;
        }
    }
}

// --- Mechanics ---
function fireBullet(source, isEnemy, opts = {}) {
    const now = Date.now();
    if(!isEnemy) {
        // Rate limit check handled in animate loop for player
    } else {
        if (now - (source.lastShot||0) < 1000) return; // Enemy rate limit
        source.lastShot = now;
    }

    const geo = new THREE.CylinderGeometry(0.12, 0.18, 3.4, 10); // Brighter, thicker round
    geo.rotateX(Math.PI/2);
    const color = isEnemy ? 0xff5522 : 0xfff3a1;
    const mat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: isEnemy ? 0.9 : 1.0,
        blending: isEnemy ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
    });
    const b = new THREE.Mesh(geo, mat);
    if(!isEnemy) {
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(0.32, 10, 10),
            new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 0.35,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                fog: false
            })
        );
        glow.scale.set(1, 1, 2.4);
        b.add(glow);
    }
    const spawnPos = opts.position || source.mesh.position.clone();
    const spawnQuat = opts.quaternion || source.mesh.quaternion.clone();
    b.position.copy(spawnPos);
    
    // Adjust spawn pos slightly
    b.position.y -= 0.2; 
    
    b.quaternion.copy(spawnQuat);
    b.translateZ(-2);
    scene.add(b);
    bullets.push({ mesh: b, life: 80, isEnemy: isEnemy, ownerId: opts.ownerId || (netPlayerId || 'local'), fromRemote: opts.fromRemote });

    // Visuals
    if(!isEnemy && source === player) {
        // Flash ON
        muzzleFlashLight.intensity = 5.0;
        setTimeout(() => { muzzleFlashLight.intensity = 0; }, 50); // Flash off quickly
    }

    if(gameMode !== GAME_MODES.LOCAL && !opts.fromRemote) {
        sendNet('action', {
            action: 'fireBullet',
            isEnemy: isEnemy,
            position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
            quaternion: { x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w }
        });
    }
}

// ... (Environment, Entities, Missile functions similar to before) ...
// Re-implementing simplified versions for brevity while keeping new logic

function setupEnvironment(stage) {
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(100, 200, 50);
    sun.castShadow = true;
    scene.add(sun);

    if (stage === 'OCEAN') {
        scene.background = new THREE.Color(0x87CEEB);
        scene.fog = new THREE.Fog(0x87CEEB, 200, 1000);
        createOcean();
        createClouds(0xffffff, 50);
    } else if (stage === 'CITY') {
        scene.background = new THREE.Color(0x050510);
        scene.fog = new THREE.FogExp2(0x050510, 0.002);
        createCityGround();
        createBuildings();
    } else if (stage === 'WASTELAND') {
        scene.background = new THREE.Color(0xcc9966);
        scene.fog = new THREE.FogExp2(0xcc9966, 0.0025);
        createWasteland();
        createRocks();
    }
}

function createOcean() {
    const geo = new THREE.PlaneGeometry(CONFIG.seaSize, CONFIG.seaSize, 40, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshPhongMaterial({ color: 0x0044aa, shininess: 80, flatShading: true, transparent: true, opacity: 0.9 });
    environmentMesh = new THREE.Mesh(geo, mat);
    environmentMesh.position.y = -10;
    scene.add(environmentMesh);
}
function createCityGround() {
    const geo = new THREE.PlaneGeometry(CONFIG.seaSize, CONFIG.seaSize, 20, 20);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
    environmentMesh = new THREE.Mesh(geo, mat);
    environmentMesh.position.y = -2;
    scene.add(environmentMesh);
    const grid = new THREE.GridHelper(CONFIG.seaSize, 40, 0x00ffcc, 0x222222);
    grid.position.y = -1;
    scene.add(grid);
}
function createWasteland() {
    const geo = new THREE.PlaneGeometry(CONFIG.seaSize, CONFIG.seaSize, 50, 50);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for(let i=0; i<pos.count; i++) {
        const x = pos.getX(i); const z = pos.getZ(i);
        pos.setY(i, Math.sin(x/50)*Math.cos(z/50)*10 + Math.random()*2);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8b4513, roughness: 1.0, flatShading: true });
    environmentMesh = new THREE.Mesh(geo, mat);
    environmentMesh.position.y = -20;
    scene.add(environmentMesh);
}
function createClouds(color, count) {
    const geo = new THREE.DodecahedronGeometry(12, 0);
    const mat = new THREE.MeshStandardMaterial({ color: color, transparent: true, opacity: 0.5, flatShading: true });
    for(let i=0; i<count; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set((Math.random()-0.5)*1500, 50+(Math.random()*100), (Math.random()-0.5)*1500);
        m.scale.set(1+Math.random()*2, 0.5+Math.random(), 1+Math.random()*2);
        scene.add(m);
    }
}
function createBuildings() {
    const geo = new THREE.BoxGeometry(1,1,1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.1, emissive: 0x000033 });
    for(let i=0; i<80; i++) {
        const h = 20 + Math.random() * 80;
        const building = new THREE.Mesh(geo, mat);
        building.position.set((Math.random()-0.5)*1200, h/2 - 2, (Math.random()-0.5)*1200);
        building.scale.set(10+Math.random()*20, h, 10+Math.random()*20);
        scene.add(building);
        obstacles.push(building);
    }
}
function createRocks() {
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5c4033, flatShading: true });
    for(let i=0; i<60; i++) {
        const s = 10 + Math.random() * 40;
        const rock = new THREE.Mesh(geo, mat);
        rock.position.set((Math.random()-0.5)*1200, -10+Math.random()*10, (Math.random()-0.5)*1200);
        rock.scale.set(s, s*1.5, s);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        scene.add(rock);
        obstacles.push(rock);
    }
}

function createPlayer(options = {}) {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: options.bodyColor || 0x607d8b, roughness: 0.6, flatShading: true });
    const cockpitMat = new THREE.MeshStandardMaterial({ color: options.cockpitColor || 0xffd54f, roughness: 0.2, emissive: options.cockpitColor || 0xffb300, emissiveIntensity: 0.2 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4, 6), bodyMat);
    body.rotateX(Math.PI / 2); group.add(body);
    const engine = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 2), bodyMat);
    engine.position.z = 1.5; group.add(engine);
    const cockpit = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), cockpitMat);
    cockpit.scale.set(1, 0.6, 2); cockpit.position.set(0, 0.4, -0.2); group.add(cockpit);
    
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0,0); wingShape.lineTo(2.5,1.5); wingShape.lineTo(2.5,2.5); wingShape.lineTo(0,1.5);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, {steps:1, depth:0.1, bevelEnabled:false});
    wingGeo.center();
    const lWing = new THREE.Mesh(wingGeo, bodyMat);
    lWing.rotation.x = Math.PI/2; lWing.rotation.z = -Math.PI/2; lWing.position.set(-1.4,0,0.5); group.add(lWing);
    const rWing = lWing.clone(); rWing.rotation.z = Math.PI/2; rWing.rotation.y = Math.PI; rWing.position.set(1.4,0,0.5); group.add(rWing);
    
    let flame = null;
    if(!options.disableFlame) {
        flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3, 8), new THREE.MeshBasicMaterial({color: options.flameColor || 0x00ffff, transparent:true, opacity:0.8}));
        flame.rotateX(-Math.PI/2); flame.position.z = 4; group.add(flame);
    }
    return { mesh: group, speed: CONFIG.playerSpeedMin, flame: flame };
}

function createEnemy() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.7, flatShading: true });
    const cockpitMat = new THREE.MeshStandardMaterial({ color: 0xff5252, emissive: 0xaa0000, emissiveIntensity: 0.5 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4, 6), bodyMat);
    body.rotateX(Math.PI/2); group.add(body);
    const cockpit = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), cockpitMat);
    cockpit.scale.set(1, 0.6, 2); cockpit.position.set(0, 0.4, -0.2); group.add(cockpit);
    const wingGeo = new THREE.BoxGeometry(5, 0.1, 2);
    wingGeo.translate(0, 0, 0.5);
    const wings = new THREE.Mesh(wingGeo, bodyMat);
    group.add(wings);
    return { mesh: group, speed: CONFIG.enemySpeed, lastShot: 0 };
}

function ensureRemotePlayer(id) {
    if(remotePlayers[id]) return remotePlayers[id];
    const rp = createPlayer({ bodyColor: 0xff7043, cockpitColor: 0xffccbc, flameColor: 0xffab91 });
    rp.id = id;
    rp.armor = 100;
    rp.score = 0;
    rp.marker = createOpponentMarker();
    scene.add(rp.mesh);
    remotePlayers[id] = rp;
    return rp;
}

function createOpponentMarker() {
    const marker = document.createElement('div');
    marker.className = 'opponent-marker';
    marker.innerHTML = `<span class="marker-dist">0m</span>`;
    ui.markersLayer.appendChild(marker);
    return marker;
}

function removeRemotePlayer(id) {
    const rp = remotePlayers[id];
    if(!rp) return;
    scene.remove(rp.mesh);
    if(rp.marker) rp.marker.remove();
    delete remotePlayers[id];
}

function applyRemoteState(msg) {
    if(!msg.playerId || msg.playerId === netPlayerId) return;
    const rp = ensureRemotePlayer(msg.playerId);
    if(msg.pos) rp.mesh.position.set(msg.pos.x, msg.pos.y, msg.pos.z);
    if(msg.rot) rp.mesh.quaternion.set(msg.rot.x, msg.rot.y, msg.rot.z, msg.rot.w);
    rp.speed = msg.speed || CONFIG.playerSpeedMin;
    if(rp.flame) rp.flame.scale.z = rp.speed * 2;
    if(typeof msg.armor === 'number') rp.armor = msg.armor;
    if(typeof msg.score === 'number') rp.score = msg.score;
    if(typeof msg.lives === 'number') rp.lives = msg.lives;
}

function handleRemoteAction(msg) {
    if(!msg.playerId || msg.playerId === netPlayerId) return;
    const rp = ensureRemotePlayer(msg.playerId);
    const spawnPos = msg.position ? new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z) : rp.mesh.position.clone();
    const quat = msg.quaternion ? new THREE.Quaternion(msg.quaternion.x, msg.quaternion.y, msg.quaternion.z, msg.quaternion.w) : rp.mesh.quaternion.clone();
    if(msg.action === 'fireBullet') {
        const asEnemy = gameMode === GAME_MODES.ONLINE_VS;
        fireBullet(rp, asEnemy, { fromRemote: true, ownerId: msg.playerId, position: spawnPos, quaternion: quat });
    }
    if(msg.action === 'fireMissile') {
        const asEnemy = gameMode === GAME_MODES.ONLINE_VS;
        fireMissile(rp, asEnemy, { fromRemote: true, ownerId: msg.playerId, position: spawnPos, quaternion: quat });
    }
    if(msg.action === 'gameOver') {
        showMessage('OPPONENT DOWN', 1200);
    }
}

function handleRemoteHit(msg) {
    if(msg.targetId && msg.targetId === netPlayerId) {
        armor -= msg.amount || 0;
        if(armor < 0) armor = 0;
        showMessage('HIT', 500);
    }
}

function applyEnemySnapshot(snapshot) {
    if(!snapshot || isNetHost) return;
    pendingEnemySnapshot = snapshot;
}

function handleWelcome(info) {
    netPlayerId = info.playerId;
    isNetHost = info.isHost;
    netRoom = info.room;
    gameMode = info.mode || gameMode;
    pendingStage = info.stage || pendingStage || currentStage;
    setNetStatus(`ROOM ${netRoom}`, 'online');
    if(info.count >= 2) {
        startMatchFromNet();
    } else {
        showWaiting(`ROOM ${netRoom} // WAITING FOR PILOT`);
    }
}

function startMatchFromNet() {
    waitingForOpponent = false;
    if(!pendingStage) pendingStage = currentStage;
    startGame(pendingStage, { mode: gameMode, isHost: isNetHost, roomCode: netRoom });
}

function syncEnemiesFromSnapshot(snapshot) {
    if(!snapshot) return;
    if(typeof snapshot.teamScore === 'number') {
        score = snapshot.teamScore;
        updateUI();
    }
    const ids = new Set();
    snapshot.enemies.forEach(es => {
        ids.add(es.id);
        let e = enemies.find(en => en.id === es.id);
        if(!e) {
            e = createEnemy();
            e.id = es.id;
            e.hp = es.hp || 1;
            scene.add(e.mesh);
            enemies.push(e);
            attachEnemyMarker(e);
        }
        e.mesh.position.set(es.x, es.y, es.z);
    });
    for(let i=enemies.length-1; i>=0; i--) {
        if(!ids.has(enemies[i].id)) {
            if(enemies[i].marker) enemies[i].marker.remove();
            scene.remove(enemies[i].mesh);
            enemies.splice(i,1);
        }
    }
    pendingEnemySnapshot = null;
}

function spawnEnemy() {
    const e = createEnemy();
    e.id = ++enemyIdCounter;
    e.hp = 1;
    const angle = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 200;
    e.mesh.position.set(player.mesh.position.x + Math.cos(angle)*dist, 50, player.mesh.position.z + Math.sin(angle)*dist);
    scene.add(e.mesh);
    enemies.push(e);
    attachEnemyMarker(e);
}

function attachEnemyMarker(enemy) {
    const marker = document.createElement('div');
    marker.className = 'enemy-marker';
    marker.innerHTML = `<span class="marker-dist">0m</span>`;
    ui.markersLayer.appendChild(marker);
    enemy.marker = marker;
}

function startMissileReload() {
    if(missileReloadEndTime || !isPlaying) return;
    missileReloadEndTime = Date.now() + CONFIG.missileReloadTimeMs;
}

function fireMissile(source, isEnemy, opts = {}) {
    if(!isEnemy && !opts.fromRemote) {
        if(missileCount <= 0 || !isPlaying) return;
        const now = Date.now();
        if(now - lastMissileTime < 1000) return;
        lastMissileTime = now;
        missileCount--;
        if(missileCount === 0) startMissileReload();
        updateUI();
    }
    let target = isEnemy ? player : null;
    if(!isEnemy) {
        let minAngle = 0.5;
        const pDir = new THREE.Vector3(0,0,-1).applyQuaternion(source.mesh.quaternion);
        enemies.forEach(e => {
            const toE = new THREE.Vector3().subVectors(e.mesh.position, source.mesh.position).normalize();
            const a = pDir.angleTo(toE);
            if(a < minAngle) { target = e; minAngle = a; }
        });
        if(target && !opts.fromRemote) showMessage("FOX 2", 800);
    }
    const geo = new THREE.CylinderGeometry(0.12, 0.16, 1.4, 10);
    geo.rotateX(Math.PI/2);
    const missileColor = isEnemy ? 0xff3300 : 0xffffff;
    const missileMat = new THREE.MeshBasicMaterial({
        color: missileColor,
        transparent: true,
        opacity: 0.95,
        blending: isEnemy ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
    });
    const m = new THREE.Mesh(geo, missileMat);
    if(!isEnemy) {
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 10, 10),
            new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.4,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                fog: false
            })
        );
        glow.scale.set(1, 1, 2);
        m.add(glow);
    }
    const spawnPos = opts.position || source.mesh.position.clone();
    const spawnQuat = opts.quaternion || source.mesh.quaternion.clone();
    m.position.copy(spawnPos); m.position.y -= 0.5;
    m.quaternion.copy(spawnQuat);
    scene.add(m);
    const missileSpeed = (source.speed || player.speed) * CONFIG.missileSpeedMultiplier;
    missiles.push({ mesh: m, target: target, life: 300, speed: missileSpeed, isEnemy: isEnemy, ownerId: opts.ownerId || (netPlayerId || 'local'), fromRemote: opts.fromRemote });

    if(gameMode !== GAME_MODES.LOCAL && !opts.fromRemote) {
        sendNet('action', {
            action: 'fireMissile',
            isEnemy: isEnemy,
            position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
            quaternion: { x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w }
        });
    }
}

function createExplosion(pos, scale) {
    for(let i=0; i<10; i++) {
        const geo = new THREE.BoxGeometry(0.8,0.8,0.8);
        const mat = new THREE.MeshBasicMaterial({color: Math.random()>0.3?0xffaa00:0xff3300});
        const m = new THREE.Mesh(geo, mat);
        m.position.copy(pos);
        m.scale.setScalar(scale);
        m.position.add(new THREE.Vector3((Math.random()-.5)*scale, (Math.random()-.5)*scale, (Math.random()-.5)*scale));
        const vel = new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).normalize().multiplyScalar(scale*0.4);
        scene.add(m);
        particles.push({mesh: m, vel: vel, life: 40, maxLife: 40});
    }
}

function showMessage(txt, dur) {
    ui.msg.innerText = txt; ui.msg.style.opacity = 1;
    setTimeout(() => ui.msg.style.opacity = 0, dur);
}
function updateUI() {
    ui.score.innerText = score;
    const hp = Math.max(0, Math.floor(armor));
    ui.hpBar.style.width = hp + '%';
    ui.hpBar.style.background = hp>30 ? '#fff' : '#ff3333';
    ui.hpBar.style.boxShadow = hp>30 ? '0 0 15px #fff' : '0 0 15px red';
    if(missileReloadEndTime) {
        const remaining = Math.max(0, Math.ceil((missileReloadEndTime - Date.now()) / 1000));
        ui.missile.innerText = `RELOAD ${remaining}s`;
        ui.missile.classList.add('reloading');
    } else {
        ui.missile.innerText = missileCount;
        ui.missile.classList.remove('reloading');
    }
    if(ui.lives) {
        if(gameMode === GAME_MODES.ONLINE_VS) {
            ui.lives.innerText = lives;
            if(ui.livesPanel) ui.livesPanel.style.display = 'block';
        } else {
            ui.lives.innerText = '—';
            if(ui.livesPanel) ui.livesPanel.style.display = 'none';
        }
    }
}
function saveScore(s) {
    let sc = JSON.parse(localStorage.getItem(scoreListKey)||'[]'); sc.push(s);
    sc.sort((a,b)=>b-a); sc=sc.slice(0,5); localStorage.setItem(scoreListKey, JSON.stringify(sc));
}
function updateHighScoreDisplay() {
    let sc = JSON.parse(localStorage.getItem(scoreListKey)||'[]');
    ui.highScoreList.innerHTML = '';
    for(let i=0; i<5; i++) {
        let s = sc[i]!==undefined ? sc[i] : '---';
        let li = document.createElement('li'); li.innerHTML = `<span style="float:left; opacity:0.7">RANK ${i+1}</span><span style="float:right">${s}</span><div style="clear:both"></div>`;
        li.style.borderBottom='1px solid rgba(255,255,255,0.2)'; li.style.padding='10px 0';
        ui.highScoreList.appendChild(li);
    }
}
function onKey(e, down) {
    const k = e.key.toLowerCase();
    if(keys[k] !== undefined) keys[k] = down;
    if(k === ' ' && down) fireMissile(player, false);
}
function onMouseMove(e) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
}
function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    if(!isPlaying) { renderer.render(scene, camera); return; }
    requestAnimationFrame(animate);

    if(pendingEnemySnapshot && gameMode === GAME_MODES.ONLINE_COOP && !isNetHost) {
        syncEnemiesFromSnapshot(pendingEnemySnapshot);
    }

    if(gameMode !== GAME_MODES.LOCAL && netClient && netClient.isOpen()) {
        const now = Date.now();
        if(now - lastNetStateSent > 80) {
            const p = player.mesh.position, q = player.mesh.quaternion;
            sendNet('state', {
                pos: { x: p.x, y: p.y, z: p.z },
                rot: { x: q.x, y: q.y, z: q.z, w: q.w },
                speed: player.speed,
                armor: armor,
                score: score,
                lives: lives
            });
            lastNetStateSent = now;
        }
    }

    // --- 1. CONTINUOUS FIRE LOGIC ---
    if(mouse.isDown) {
        const now = Date.now();
        if(now - lastShotTime > CONFIG.fireRate) {
            fireBullet(player, false);
            lastShotTime = now;
        }
    }

    // Player Move
    if(keys.w) player.speed = Math.min(player.speed+0.05, CONFIG.playerSpeedMax);
    else if(keys.s) player.speed = Math.max(player.speed-0.05, CONFIG.playerSpeedMin);
    else player.speed += (1.0 - player.speed) * 0.01;
    
    const turn = (keys.a ? 1 : 0) + (keys.d ? -1 : 0);
    player.mesh.rotation.y += turn * CONFIG.turnSpeed;
    player.mesh.rotation.z += (turn * 0.6 - player.mesh.rotation.z) * 0.1;
    player.mesh.rotation.x = 0;

    const fwd = new THREE.Vector3(0,0,-player.speed).applyAxisAngle(new THREE.Vector3(0,1,0), player.mesh.rotation.y);
    player.mesh.position.add(fwd);
    player.flame.scale.z = player.speed * 2;

    const camOff = new THREE.Vector3(0, 5, 15).applyAxisAngle(new THREE.Vector3(0,1,0), player.mesh.rotation.y);
    camera.position.lerp(player.mesh.position.clone().add(camOff), 0.1);
    camera.lookAt(player.mesh.position.clone().add(fwd.clone().multiplyScalar(20)));

    // Env
    if(environmentMesh) {
        const dx = player.mesh.position.x - environmentMesh.position.x;
        const dz = player.mesh.position.z - environmentMesh.position.z;
        if(Math.abs(dx) > 100) environmentMesh.position.x += dx;
        if(Math.abs(dz) > 100) environmentMesh.position.z += dz;
        if(currentStage === 'OCEAN') {
            const pos = environmentMesh.geometry.attributes.position;
            const t = Date.now() * 0.001;
            for(let i=0; i<pos.count; i+=3) pos.setY(i, Math.sin(t+i)*2);
            pos.needsUpdate = true;
        }
    }

    if(missileReloadEndTime && Date.now() >= missileReloadEndTime) {
        missileCount = CONFIG.missileCapacity;
        missileReloadEndTime = null;
        showMessage("MISSILES READY", 1000);
    }

    // Bullets/Missiles
    const allowEnemyDamage = (gameMode === GAME_MODES.LOCAL || (gameMode === GAME_MODES.ONLINE_COOP && isNetHost));
    const isVs = gameMode === GAME_MODES.ONLINE_VS;
    [bullets, missiles].forEach(arr => {
        for(let i=arr.length-1; i>=0; i--) {
            const p = arr[i];
            p.mesh.translateZ(-((p.speed)||CONFIG.bulletSpeed));
            p.life--;
            if(p.target && p.target.mesh) {
                 const toT = new THREE.Vector3().subVectors(p.target.mesh.position, p.mesh.position).normalize();
                 const f = new THREE.Vector3(0,0,-1).applyQuaternion(p.mesh.quaternion);
                 if(f.angleTo(toT) < Math.PI/3) p.mesh.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), toT), 0.04);
            }
            if(arr === missiles && p.life % 2 === 0) {
                const t = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.3), new THREE.MeshBasicMaterial({color:0xcccccc, transparent:true, opacity:0.4}));
                t.position.copy(p.mesh.position).add(new THREE.Vector3((Math.random()-.5)*.2,(Math.random()-.5)*.2,(Math.random()-.5)*.2));
                scene.add(t); particles.push({mesh:t, vel:new THREE.Vector3(0,0,0), life:15, maxLife:15});
            }
            if(arr === bullets && !p.isEnemy && p.life % 2 === 0) {
                const t = new THREE.Mesh(
                    new THREE.SphereGeometry(0.18, 6, 6),
                    new THREE.MeshBasicMaterial({
                        color: 0xfff1a1,
                        transparent: true,
                        opacity: 0.45,
                        blending: THREE.AdditiveBlending,
                        depthWrite: false,
                        fog: false
                    })
                );
                t.position.copy(p.mesh.position);
                scene.add(t); particles.push({mesh:t, vel:new THREE.Vector3(0,0,0), life:12, maxLife:12});
            }
            
            let hit = false;
            if(p.isEnemy) {
                if(p.mesh.position.distanceTo(player.mesh.position) < 2) { hit = true; armor -= 10; createExplosion(p.mesh.position, 1); }
            } else {
                if(isVs) {
                    for(const id in remotePlayers) {
                        const rp = remotePlayers[id];
                        if(rp && rp.mesh.position.distanceTo(p.mesh.position) < 3) {
                            hit = true; createExplosion(rp.mesh.position, 3);
                            sendNet('hit', { targetId: id, amount: 10 });
                        }
                    }
                }
                if(allowEnemyDamage) {
                    for(let j=enemies.length-1; j>=0; j--) {
                        if(p.mesh.position.distanceTo(enemies[j].mesh.position) < 3) {
                            hit = true; createExplosion(enemies[j].mesh.position, 3);
                            if(enemies[j].marker) enemies[j].marker.remove();
                            scene.remove(enemies[j].mesh); enemies.splice(j, 1);
                            score += 100; setTimeout(spawnEnemy, 2000);
                        }
                    }
                }
            }
            for(let o of obstacles) if(p.mesh.position.distanceTo(o.position) < o.scale.y/2) hit = true;
            if(hit || p.life<=0) { scene.remove(p.mesh); arr.splice(i,1); }
        }
    });

    // Enemies (RELAXED ATTACK LOGIC)
    const runEnemies = (gameMode === GAME_MODES.LOCAL) || (gameMode === GAME_MODES.ONLINE_COOP && isNetHost);
    let alert = false;
    for(let i=enemies.length-1; i>=0; i--) {
        const e = enemies[i];
        const toP = new THREE.Vector3().subVectors(player.mesh.position, e.mesh.position);
        const dist = toP.length();

        if(runEnemies) {
            if(dist > 2500) {
                if(e.marker) e.marker.remove(); scene.remove(e.mesh); enemies.splice(i, 1); spawnEnemy(); continue;
            }

            toP.y = 0; toP.normalize();
            e.mesh.position.y = 50; e.mesh.rotation.x = 0; e.mesh.rotation.z = 0;
            e.mesh.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.atan2(toP.x, toP.z)+Math.PI), 0.03);
            e.mesh.translateZ(e.speed);

            if(dist < 800) {
                 const now = Date.now();
                 if(now - (e.lastShot||0) > 1000) { fireBullet(e, true); e.lastShot = now; }
                 if(Math.random() < 0.005 && dist > 100) fireMissile(e, true);
            }
        }

        if(e.marker) {
            const p = e.mesh.position.clone().project(camera);
            if(new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)).containsPoint(e.mesh.position)) {
                e.marker.style.display='flex';
                e.marker.style.left=((p.x*.5+.5)*window.innerWidth)+'px';
                e.marker.style.top=((-p.y*.5+.5)*window.innerHeight)+'px';
                e.marker.querySelector('.marker-dist').innerText=Math.floor(dist)+'m';
            } else e.marker.style.display='none';
        }
    }

    if(gameMode === GAME_MODES.ONLINE_VS) {
        for(const id in remotePlayers) {
            const rp = remotePlayers[id];
            if(!rp || !rp.marker) continue;
            const p = rp.mesh.position.clone().project(camera);
            const visible = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)).containsPoint(rp.mesh.position);
            if(visible) {
                rp.marker.style.display='flex';
                rp.marker.style.left=((p.x*.5+.5)*window.innerWidth)+'px';
                rp.marker.style.top=((-p.y*.5+.5)*window.innerHeight)+'px';
                rp.marker.querySelector('.marker-dist').innerText=Math.floor(player.mesh.position.distanceTo(rp.mesh.position))+'m';
            } else rp.marker.style.display='none';
        }
    }

    if(runEnemies && gameMode === GAME_MODES.ONLINE_COOP && netClient && netClient.isOpen()) {
        const now = Date.now();
        if(now - lastEnemySnapshotTime > 200) {
            sendNet('enemySnapshot', {
                enemies: enemies.map(en => ({
                    id: en.id,
                    x: en.mesh.position.x,
                    y: en.mesh.position.y,
                    z: en.mesh.position.z,
                    hp: en.hp || 1
                })),
                teamScore: score
            });
            lastEnemySnapshotTime = now;
        }
    }

    // Particles
    for(let i=particles.length-1; i>=0; i--) {
        const p = particles[i]; p.mesh.position.add(p.vel); p.life--; p.mesh.scale.multiplyScalar(0.95); p.mesh.material.opacity = p.life/p.maxLife;
        if(p.life<=0) { scene.remove(p.mesh); particles.splice(i,1); }
    }

    // Radar
    while(ui.radar.children.length>0) ui.radar.removeChild(ui.radar.lastChild);
    const radarRadius = 80;
    const scale = radarRadius / RADAR_RANGE;
    // Player center dot
    let pd = document.createElement('div'); pd.className='radar-player'; ui.radar.appendChild(pd);
    const addDot = (rel, cls) => {
        rel.applyAxisAngle(new THREE.Vector3(0,1,0), -player.mesh.rotation.y);
        let rx = rel.x * scale, rz = rel.z * scale;
        const rd = Math.sqrt(rx*rx+rz*rz);
        if(rd > radarRadius) { rx *= radarRadius/rd; rz *= radarRadius/rd; }
        const d=document.createElement('div'); d.className=cls; d.style.left=(radarRadius+rx)+'px'; d.style.top=(radarRadius+rz)+'px'; ui.radar.appendChild(d);
    };
    for(let e of enemies) {
         const rel = e.mesh.position.clone().sub(player.mesh.position);
         addDot(rel, 'radar-dot');
    }
    if(gameMode === GAME_MODES.ONLINE_VS) {
        for(const id in remotePlayers) {
            const rp = remotePlayers[id];
            if(!rp) continue;
            const rel = rp.mesh.position.clone().sub(player.mesh.position);
            addDot(rel, 'radar-opponent');
        }
    }
    for(let m of missiles) if(m.isEnemy) alert = true;
    ui.alert.style.display = alert ? 'block' : 'none';

    if(armor <= 0) {
        if(gameMode === GAME_MODES.ONLINE_VS) {
            if(lives > 1) {
                lives--;
                armor = 100;
                missileCount = CONFIG.missileCapacity;
                player.speed = CONFIG.playerSpeedMin;
                player.mesh.position.set(0, 50, 0);
                player.mesh.rotation.set(0, 0, 0);
                showMessage(`RESPAWN - LIVES ${lives}`, 1000);
                updateUI();
            } else {
                sendNet('action', { action: 'gameOver' });
                gameOver();
            }
        } else {
            gameOver();
        }
    }
    updateUI();
    renderer.render(scene, camera);
}

init();
animate(); // Start loop for menu bg
