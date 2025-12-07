const CONFIG = {
    playerSpeedMin: 0.3, playerSpeedMax: 1.2,
    cruiseSpeed: 1.0,
    speedResponse: 0.08,
    turboMultiplier: 1.7,
    turboChargeRate: 0.22, // per second
    turboDrainRate: 0.7, // per second while turbo is active
    playerFlameColor: 0x00ffff,
    turboFlameColor: 0xffb347,
    turnSpeed: 0.015,
    bulletSpeed: 6.0, 
    missileSpeedMultiplier: 1.3, // Missiles move at ~1.3x the player's current speed
    missileCapacity: 20,
    missileReloadTimeMs: 30000, // 30s reload when missiles are depleted
    enemySpeed: 0.5,
    enemyApproachSpeed: 0.8,
    enemyStrafeSpeed: 0.65,
    enemyEvadeSpeed: 0.9,
    enemyTurnLerp: 0.15,
    enemyApproachDistance: 1300,
    enemyHoldDistance: 650,
    enemyEvadeDistance: 450,
    enemyGunRange: 900,
    enemyGunHitRadius: 2.6,
    playerGunHitRadius: 3.2,
    enemyFireProfiles: {
        approach: { fireIntervalMs: 320, burst: 3, burstCooldownMs: 1400, maxAngle: 0.8 },
        strafe:   { fireIntervalMs: 260, burst: 4, burstCooldownMs: 1100, maxAngle: 1.0 },
        evade:    { fireIntervalMs: 420, burst: 2, burstCooldownMs: 1700, maxAngle: 0.9 }
    },
    enemyMissileScheduler: {
        minRange: 140,
        maxRange: 1050,
        maxAngle: 0.55,
        staggerMs: 750,
        requeueDelayMs: 5200
    },
    seaSize: 2000,
    fireRate: 80 // ms between shots
};

const GAME_MODES = { LOCAL: 'LOCAL', ONLINE_VS: 'ONLINE_VS', ONLINE_COOP: 'ONLINE_COOP' };
const NET_DEFAULT_URL = 'ws://localhost:3001';

// Globals
let scene, camera, renderer;
let player, environmentMesh, obstacles = [];
let bullets = [], missiles = [], enemies = [], particles = [];
let missileQueue = [];
const PLAYER_FLAME_COLOR = new THREE.Color(CONFIG.playerFlameColor);
const TURBO_FLAME_COLOR = new THREE.Color(CONFIG.turboFlameColor);
let keys = { w: false, s: false, a: false, d: false, space: false, turbo: false };
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
let stats = { damageDealt: 0, damageTaken: 0, kills: 0, deaths: 0 };
const DEFAULT_SPAWN_HEIGHT = 50;
let score = 0, armor = 100, missileCount = CONFIG.missileCapacity;
let lastShotTime = 0, lastMissileTime = 0, missileReloadEndTime = null;
let muzzleFlashLight;
let turboCharge = 1;
let turboLocked = false;
const scoreListKey = 'aceWingHighScores';
let lastFrameTime = Date.now();

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
    waitingText: document.getElementById('waiting-text'),
    speed: document.getElementById('speed-val'),
    turboBar: document.getElementById('turbo-bar-fill'),
    turboVal: document.getElementById('turbo-val')
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
    rank: document.getElementById('result-rank'),
    outcome: document.getElementById('result-outcome'),
    dmgDealt: document.getElementById('stat-dmg-dealt'),
    dmgTaken: document.getElementById('stat-dmg-taken'),
    kills: document.getElementById('stat-kills'),
    deaths: document.getElementById('stat-deaths')
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
    stats = { damageDealt: 0, damageTaken: 0, kills: 0, deaths: 0 };
    turboCharge = 1;
    turboLocked = false;
    lastNetStateSent = 0; pendingEnemySnapshot = null; lastEnemySnapshotTime = 0;
    
    while(scene.children.length > 0) scene.remove(scene.children[0]);
    bullets = []; missiles = []; enemies = []; particles = []; obstacles = []; missileQueue = [];
    ui.markersLayer.innerHTML = ''; 

    setupEnvironment(stage);
    
    player = createPlayer({ bodyColor: 0x607d8b, cockpitColor: 0xffd54f });
    scene.add(player.mesh);
    applySpawnPose(player);

    // Muzzle Flash Effect Setup
    muzzleFlashLight = new THREE.PointLight(0xffffaa, 0, 20); // Initially 0 intensity
    player.mesh.add(muzzleFlashLight);
    muzzleFlashLight.position.set(0, 0, -3); // Near noise

    updateUI();
    setScreen('playing');
    ui.gameOverMsg.style.display = 'none';

    if(gameMode !== GAME_MODES.ONLINE_VS && (gameMode !== GAME_MODES.ONLINE_COOP || isNetHost)) {
        for(let i=0; i<8; i++) spawnEnemy();
    }
    
    animate();
}

function gameOver(outcome='LOSE') {
    if(!isPlaying) return;
    isPlaying = false;
    if(gameMode !== GAME_MODES.ONLINE_VS) {
        saveScore(score);
        updateHighScoreDisplay();
    }
    ui.gameOverMsg.style.display = 'none';
    showResult(outcome);
}

function showResult(outcome='LOSE') {
    resultUI.score.innerText = score;
    const r = getRank(score);
    resultUI.rank.innerText = r;
    resultUI.rank.className = 'rank-badge';
    resultUI.rank.classList.add(`rank-${r}`);
    if(resultUI.outcome) {
        resultUI.outcome.innerText = outcome === 'WIN' ? 'WINNER' : (outcome === 'DRAW' ? 'DRAW' : 'LOSER');
        resultUI.outcome.style.color = outcome === 'WIN' ? '#7CFFB2' : (outcome === 'DRAW' ? '#fff' : '#ff6666');
    }
    if(resultUI.dmgDealt) resultUI.dmgDealt.innerText = stats.damageDealt;
    if(resultUI.dmgTaken) resultUI.dmgTaken.innerText = stats.damageTaken;
    if(resultUI.kills) resultUI.kills.innerText = stats.kills;
    if(resultUI.deaths) resultUI.deaths.innerText = stats.deaths;
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
    if(isEnemy && !opts.fromRemote) {
        const minInterval = opts.minIntervalMs || 1000;
        if(!opts.bypassRateLimiter) {
            if (now - (source.lastShot||0) < minInterval) return; // Enemy rate limit
            source.lastShot = now;
        }
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
    bullets.push({ mesh: b, life: Math.ceil(CONFIG.enemyGunRange / CONFIG.bulletSpeed), isEnemy: isEnemy, ownerId: opts.ownerId || (netPlayerId || 'local'), fromRemote: opts.fromRemote });

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

function getPlayerVelocity() {
    const dir = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0,1,0), player.mesh.rotation.y);
    return dir.multiplyScalar(player.speed || CONFIG.cruiseSpeed);
}

function computeLeadQuaternion(shooter, toTargetVec) {
    const shooterVel = shooter.velocity ? shooter.velocity.clone() : new THREE.Vector3();
    const targetVel = getPlayerVelocity();
    const relativeVel = targetVel.sub(shooterVel);
    const distance = toTargetVec.length();
    const timeToImpact = Math.min(2.5, distance / CONFIG.bulletSpeed);
    const predictedPos = player.mesh.position.clone().add(relativeVel.multiplyScalar(timeToImpact));
    const aimDir = predictedPos.sub(shooter.mesh.position);
    if(aimDir.lengthSq() < 0.0001) aimDir.copy(toTargetVec);
    aimDir.y = 0;
    aimDir.normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), aimDir);
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
        const flameColor = options.flameColor || CONFIG.playerFlameColor;
        flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3, 8), new THREE.MeshBasicMaterial({color: flameColor, transparent:true, opacity:0.8}));
        flame.rotateX(-Math.PI/2); flame.position.z = 4; group.add(flame);
    }
    return { mesh: group, speed: CONFIG.cruiseSpeed, flame: flame };
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
    return {
        mesh: group,
        speed: CONFIG.enemySpeed,
        lastShot: 0,
        velocity: new THREE.Vector3(),
        state: 'approach',
        stateTimer: 0,
        strafeDir: Math.random() < 0.5 ? -1 : 1,
        burstRemaining: 0,
        nextShotAt: 0,
        nextBurstAt: 0,
        missileQueued: false,
        nextMissileWindow: 0
    };
}

function getEnemyFireProfile(state) {
    return CONFIG.enemyFireProfiles[state] || CONFIG.enemyFireProfiles.approach;
}

function handleEnemyGunAttack(enemy, toPlayer, dist, now) {
    if(dist > CONFIG.enemyGunRange) { enemy.burstRemaining = 0; return; }
    const profile = getEnemyFireProfile(enemy.state);
    const forward = new THREE.Vector3(0,0,-1).applyQuaternion(enemy.mesh.quaternion);
    const angle = forward.angleTo(toPlayer.clone().normalize());
    if(angle > profile.maxAngle) { enemy.burstRemaining = 0; return; }
    if(now < enemy.nextBurstAt) return;

    if(enemy.burstRemaining <= 0) {
        enemy.burstRemaining = profile.burst;
        enemy.nextShotAt = now;
    }

    if(now >= enemy.nextShotAt && enemy.burstRemaining > 0) {
        const aimQuat = computeLeadQuaternion(enemy, toPlayer.clone());
        fireBullet(enemy, true, { bypassRateLimiter: true, quaternion: aimQuat });
        enemy.burstRemaining -= 1;
        enemy.nextShotAt = now + profile.fireIntervalMs;
        if(enemy.burstRemaining <= 0) {
            enemy.nextBurstAt = now + profile.burstCooldownMs;
        }
    }
}

function queueEnemyMissile(enemy, toPlayer, dist, now) {
    const cfg = CONFIG.enemyMissileScheduler;
    if(dist < cfg.minRange || dist > cfg.maxRange) return;
    const forward = new THREE.Vector3(0,0,-1).applyQuaternion(enemy.mesh.quaternion);
    const angle = forward.angleTo(toPlayer.clone().normalize());
    if(angle > cfg.maxAngle) return;
    if(enemy.missileQueued || now < enemy.nextMissileWindow) return;
    missileQueue.push({ enemyId: enemy.id, time: now + cfg.staggerMs * missileQueue.length });
    enemy.missileQueued = true;
    enemy.nextMissileWindow = now + cfg.requeueDelayMs;
}

function processMissileQueue(now) {
    missileQueue = missileQueue.filter(entry => enemies.some(e => e.id === entry.enemyId));
    missileQueue.sort((a,b) => a.time - b.time);
    while(missileQueue.length && missileQueue[0].time <= now) {
        const entry = missileQueue.shift();
        const enemy = enemies.find(e => e.id === entry.enemyId);
        if(enemy) {
            fireMissile(enemy, true);
            enemy.missileQueued = false;
        }
    }
}

function ensureRemotePlayer(id) {
    if(remotePlayers[id]) return remotePlayers[id];
    const rp = createPlayer({ bodyColor: 0xff7043, cockpitColor: 0xffccbc, flameColor: 0xffab91 });
    rp.id = id;
    rp.armor = 100;
    rp.score = 0;
    rp.marker = createOpponentMarker();
    rp.targetPos = rp.mesh.position.clone();
    rp.targetQuat = rp.mesh.quaternion.clone();
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

function selectPvpTarget(source) {
    let best = null;
    let bestAngle = 0.6;
    const forward = new THREE.Vector3(0,0,-1).applyQuaternion(source.mesh.quaternion);
    Object.values(remotePlayers).forEach(rp => {
        const to = new THREE.Vector3().subVectors(rp.mesh.position, source.mesh.position).normalize();
        const a = forward.angleTo(to);
        if(a < bestAngle) { best = rp; bestAngle = a; }
    });
    return best;
}

function resolveMissileTarget(msg) {
    if(!msg.targetType) return null;
    if(msg.targetType === 'player') {
        if(msg.targetId === netPlayerId) return player.mesh;
        if(remotePlayers[msg.targetId]) return remotePlayers[msg.targetId].mesh;
    }
    if(msg.targetType === 'enemy' && msg.targetId !== undefined) {
        const e = enemies.find(en => en.id === msg.targetId);
        return e ? e.mesh : null;
    }
    return null;
}

function hashStringToAngle(str) {
    if(!str) return 0;
    let h = 0;
    for(let i=0; i<str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return (h % 360) * Math.PI / 180;
}

function getSpawnPose(id) {
    if(gameMode === GAME_MODES.LOCAL) {
        return { pos: new THREE.Vector3(0, DEFAULT_SPAWN_HEIGHT, 0), rotY: 0 };
    }
    const angle = hashStringToAngle(id || 'local');
    const dist = 150;
    const pos = new THREE.Vector3(Math.cos(angle) * dist, DEFAULT_SPAWN_HEIGHT, Math.sin(angle) * dist);
    // Face roughly toward origin
    const rotY = Math.atan2(-Math.sin(angle), -Math.cos(angle));
    return { pos, rotY };
}

function applySpawnPose(p) {
    const pose = getSpawnPose(netPlayerId || 'local');
    p.mesh.position.copy(pose.pos);
    p.mesh.rotation.set(0, pose.rotY, 0);
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
    const prevLives = rp.lives;
    if(msg.pos) {
        if(!rp.targetPos) rp.targetPos = new THREE.Vector3();
        rp.targetPos.set(msg.pos.x, msg.pos.y, msg.pos.z);
    }
    if(msg.rot) {
        if(!rp.targetQuat) rp.targetQuat = new THREE.Quaternion();
        rp.targetQuat.set(msg.rot.x, msg.rot.y, msg.rot.z, msg.rot.w);
    }
    rp.speed = msg.speed || CONFIG.playerSpeedMin;
    if(rp.flame) rp.flame.scale.z = rp.speed * 2;
    if(typeof msg.armor === 'number') rp.armor = msg.armor;
    if(typeof msg.score === 'number') rp.score = msg.score;
    if(typeof msg.lives === 'number') {
        rp.lives = msg.lives;
        if(gameMode === GAME_MODES.ONLINE_VS && typeof prevLives === 'number' && prevLives > rp.lives) {
            stats.kills += (prevLives - rp.lives);
        }
    }
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
        const target = resolveMissileTarget(msg);
        fireMissile(rp, asEnemy, { fromRemote: true, ownerId: msg.playerId, position: spawnPos, quaternion: quat, targetType: msg.targetType, targetId: msg.targetId, resolvedTarget: target });
    }
    if(msg.action === 'gameOver') {
        const loserId = msg.loserId || msg.playerId;
        if(loserId === netPlayerId) {
            if(isPlaying) gameOver('LOSE');
        } else {
            if(isPlaying) gameOver('WIN');
        }
    }
}

function handleRemoteHit(msg) {
    if(msg.targetId && msg.targetId === netPlayerId) {
        armor -= msg.amount || 0;
        if(armor < 0) armor = 0;
        showMessage('HIT', 500);
        stats.damageTaken += msg.amount || 0;
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
    const dist = 400 + Math.random() * 300;
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
    let target = opts.resolvedTarget || null;
    let targetType = opts.targetType || null;
    let targetId = opts.targetId || null;
    if(!target) {
        if(isEnemy) {
            target = player.mesh;
            targetType = 'player';
            targetId = netPlayerId || 'local';
        } else if(gameMode === GAME_MODES.ONLINE_VS) {
            const chosen = selectPvpTarget(source);
            if(chosen) {
                target = chosen.mesh;
                targetType = 'player';
                targetId = chosen.id || null;
            }
            if(target && !opts.fromRemote) showMessage("FOX 2", 800);
        } else {
            let minAngle = 0.5;
            const pDir = new THREE.Vector3(0,0,-1).applyQuaternion(source.mesh.quaternion);
            enemies.forEach(e => {
                const toE = new THREE.Vector3().subVectors(e.mesh.position, source.mesh.position).normalize();
                const a = pDir.angleTo(toE);
                if(a < minAngle) { target = e.mesh || e; minAngle = a; targetType = 'enemy'; targetId = e.id; }
            });
            if(target && !opts.fromRemote) showMessage("FOX 2", 800);
        }
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
    missiles.push({ mesh: m, target: target, targetType, targetId, life: 300, speed: missileSpeed, isEnemy: isEnemy, ownerId: opts.ownerId || (netPlayerId || 'local'), fromRemote: opts.fromRemote });

    if(gameMode !== GAME_MODES.LOCAL && !opts.fromRemote) {
        sendNet('action', {
            action: 'fireMissile',
            isEnemy: isEnemy,
            position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
            quaternion: { x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w },
            targetType,
            targetId
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

function updateSpeedDisplay() {
    if(!ui.speed) return;
    const currentSpeed = player && player.speed ? player.speed : CONFIG.cruiseSpeed;
    ui.speed.innerText = currentSpeed.toFixed(2);
}
function updateTurboDisplay() {
    if(!ui.turboBar || !ui.turboVal) return;
    const pct = Math.floor(turboCharge * 100);
    ui.turboBar.style.width = pct + '%';
    ui.turboVal.innerText = pct + '%';
    ui.turboBar.style.background = pct > 20 ? '#00ffff' : '#ff7b47';
    ui.turboBar.style.boxShadow = pct > 20 ? '0 0 8px #00ffff' : '0 0 8px #ff7b47';
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
    if(k === 'shift') { keys.turbo = down; return; }
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

    const nowFrame = Date.now();
    const dt = Math.min(0.05, (nowFrame - lastFrameTime) / 1000);
    lastFrameTime = nowFrame;

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

    // Smooth remote players to avoid jitter
    if(gameMode !== GAME_MODES.LOCAL) {
        Object.values(remotePlayers).forEach(rp => {
            if(rp.targetPos) rp.mesh.position.lerp(rp.targetPos, 0.2);
            if(rp.targetQuat) rp.mesh.quaternion.slerp(rp.targetQuat, 0.2);
            if(rp.flame) rp.flame.scale.z = (rp.speed || CONFIG.playerSpeedMin) * 2;
        });
    }

    // --- 1. CONTINUOUS FIRE LOGIC ---
    if(mouse.isDown) {
        const now = Date.now();
        if(now - lastShotTime > CONFIG.fireRate) {
            fireBullet(player, false);
            lastShotTime = now;
        }
    }

    // Turbo charge management
    if(turboCharge <= 0.02 && !turboLocked) {
        turboLocked = true;
    }
    
    const turboActive = keys.turbo && turboCharge > 0.02 && !turboLocked;
    
    if(turboActive) {
        turboCharge = Math.max(0, turboCharge - CONFIG.turboDrainRate * dt);
    } else {
        const regenFactor = Math.max(0.5, player.speed / CONFIG.playerSpeedMax);
        turboCharge = Math.min(1, turboCharge + CONFIG.turboChargeRate * regenFactor * dt);
        if(turboLocked && turboCharge >= 1) {
            turboLocked = false;
        }
    }

    // Player Move
    const turboSpeed = CONFIG.playerSpeedMax * CONFIG.turboMultiplier;
    const targetSpeed = turboActive
        ? turboSpeed
        : (keys.s ? CONFIG.playerSpeedMin : CONFIG.cruiseSpeed);
    player.speed += (targetSpeed - player.speed) * CONFIG.speedResponse;
    player.speed = Math.max(CONFIG.playerSpeedMin, Math.min(player.speed, turboSpeed));
    
    const turn = (keys.a ? 1 : 0) + (keys.d ? -1 : 0);
    player.mesh.rotation.y += turn * CONFIG.turnSpeed;
    player.mesh.rotation.z += (turn * 0.6 - player.mesh.rotation.z) * 0.1;
    player.mesh.rotation.x = 0;

    const fwd = new THREE.Vector3(0,0,-player.speed).applyAxisAngle(new THREE.Vector3(0,1,0), player.mesh.rotation.y);
    player.mesh.position.add(fwd);
    if(player.flame) {
        player.flame.scale.z = player.speed * 2;
        const flameTargetColor = turboActive ? TURBO_FLAME_COLOR : PLAYER_FLAME_COLOR;
        player.flame.material.color.lerp(flameTargetColor, 0.2);
    }
    updateSpeedDisplay();
    updateTurboDisplay();

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
            if(arr === missiles) {
                if((!p.target || !p.target.position) && (p.targetType || p.targetId !== undefined)) {
                    const resolved = resolveMissileTarget({ targetType: p.targetType, targetId: p.targetId });
                    if(resolved) p.target = resolved;
                }
            }
            const targetMesh = p.target ? (p.target.mesh || p.target) : null;
            if(targetMesh) {
                 const toT = new THREE.Vector3().subVectors(targetMesh.position, p.mesh.position).normalize();
                 const f = new THREE.Vector3(0,0,-1).applyQuaternion(p.mesh.quaternion);
                 const desired = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), toT);
                 p.mesh.quaternion.slerp(desired, 0.08);
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
            const hitRadius = p.isEnemy ? CONFIG.enemyGunHitRadius : CONFIG.playerGunHitRadius;
            if(p.isEnemy) {
                if(p.mesh.position.distanceTo(player.mesh.position) < hitRadius) { hit = true; armor -= 10; stats.damageTaken += 10; createExplosion(p.mesh.position, 1); }
            } else {
                if(isVs) {
                    for(const id in remotePlayers) {
                        const rp = remotePlayers[id];
                        if(rp && rp.mesh.position.distanceTo(p.mesh.position) < hitRadius) {
                            hit = true; createExplosion(rp.mesh.position, 3);
                            sendNet('hit', { targetId: id, amount: 10 });
                            stats.damageDealt += 10;
                        }
                    }
                }
                if(allowEnemyDamage) {
                    for(let j=enemies.length-1; j>=0; j--) {
                        if(p.mesh.position.distanceTo(enemies[j].mesh.position) < hitRadius) {
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

    // Enemies (state-based steering)
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

            e.stateTimer = (e.stateTimer || 0) + dt;
            const prevState = e.state || 'approach';
            if(dist > CONFIG.enemyApproachDistance) e.state = 'approach';
            else if(dist < CONFIG.enemyEvadeDistance) e.state = 'evade';
            else e.state = 'strafe';
            if(e.state !== prevState) {
                e.stateTimer = 0;
                e.strafeDir = Math.random() < 0.5 ? -1 : 1;
            }

            const flatDir = toP.clone(); flatDir.y = 0;
            const baseDir = flatDir.lengthSq() > 0.0001 ? flatDir.normalize() : new THREE.Vector3(0,0,1);
            const up = new THREE.Vector3(0,1,0);
            let desiredDir = baseDir.clone();
            let desiredSpeed = CONFIG.enemySpeed;

            if(e.state === 'approach') {
                desiredSpeed = CONFIG.enemyApproachSpeed;
            } else if(e.state === 'strafe') {
                const side = new THREE.Vector3().crossVectors(baseDir, up).normalize().multiplyScalar(0.7 * (e.strafeDir || 1));
                const rangeError = dist - CONFIG.enemyHoldDistance;
                desiredDir.add(side);
                desiredDir.add(baseDir.clone().multiplyScalar(rangeError > 0 ? 0.35 : -0.35));
                desiredDir.normalize();
                desiredSpeed = CONFIG.enemyStrafeSpeed;
                if(e.stateTimer > 2.5) { e.strafeDir *= -1; e.stateTimer = 0; }
            } else {
                const side = new THREE.Vector3().crossVectors(baseDir, up).normalize().multiplyScalar(1.0 * (e.strafeDir || 1));
                desiredDir = baseDir.clone().multiplyScalar(0.3).add(side).normalize();
                desiredSpeed = CONFIG.enemyEvadeSpeed;
                if(e.stateTimer > 1.5 && dist > CONFIG.enemyHoldDistance) e.state = 'approach';
            }

            // Light separation so enemies don't stack too close
            const sep = new THREE.Vector3();
            for(let j=0; j<enemies.length; j++) {
                if(i === j) continue;
                const other = enemies[j];
                const diff = new THREE.Vector3().subVectors(e.mesh.position, other.mesh.position);
                const d = diff.length();
                if(d > 0 && d < 220) {
                    sep.add(diff.normalize().multiplyScalar((220 - d) / 220));
                }
            }
            desiredDir.add(sep.multiplyScalar(0.6)).normalize();

            e.velocity = e.velocity || new THREE.Vector3();
            const targetVel = desiredDir.multiplyScalar(desiredSpeed);
            e.velocity.lerp(targetVel, 0.1);
            e.mesh.position.add(e.velocity.clone());
            e.mesh.position.y = 50;

            const moveDir = e.velocity.lengthSq() > 0.0001 ? e.velocity.clone().normalize() : desiredDir;
            const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), moveDir);
            e.mesh.quaternion.slerp(targetQuat, CONFIG.enemyTurnLerp);

            if(dist < CONFIG.enemyGunRange) {
                handleEnemyGunAttack(e, toP, dist, nowFrame);
                queueEnemyMissile(e, toP, dist, nowFrame);
            } else {
                e.burstRemaining = 0;
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

    processMissileQueue(nowFrame);

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
            stats.deaths += 1;
            if(lives > 1) {
                lives--;
                armor = 100;
                missileCount = CONFIG.missileCapacity;
                player.speed = CONFIG.playerSpeedMin;
                applySpawnPose(player);
                showMessage(`RESPAWN - LIVES ${lives}`, 1000);
                updateUI();
            } else {
                sendNet('action', { action: 'gameOver', loserId: netPlayerId });
                gameOver('LOSE');
            }
        } else {
            gameOver('LOSE');
        }
    }
    updateUI();
    renderer.render(scene, camera);
}

init();
animate(); // Start loop for menu bg
