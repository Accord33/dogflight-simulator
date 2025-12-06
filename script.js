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

class SoundManager {
    constructor() {
        this.context = null;
        this.buffers = new Map();
        this.looping = new Map();
        this._initContext();
    }

    _initContext() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if(!AudioContext) return;
        this.context = new AudioContext();
        const unlock = () => {
            if(this.context && this.context.state === 'suspended') this.context.resume();
            document.removeEventListener('pointerdown', unlock);
            document.removeEventListener('keydown', unlock);
        };
        document.addEventListener('pointerdown', unlock, { once: true });
        document.addEventListener('keydown', unlock, { once: true });
    }

    async loadAll(manifest) {
        if(!this.context) return;
        const jobs = Object.entries(manifest).map(async ([id, factory]) => {
            if(typeof factory === 'function') {
                const buf = await factory(this.context);
                this.buffers.set(id, buf);
                return;
            }
            return;
        });
        await Promise.all(jobs);
    }

    play(id, { volume = 1, loop = false, playbackRate = 1 } = {}) {
        if(!this.context) return;
        const buf = this.buffers.get(id);
        if(!buf) return;
        const src = this.context.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = playbackRate;
        const gain = this.context.createGain();
        gain.gain.value = volume;
        src.connect(gain).connect(this.context.destination);
        if(loop) {
            this.stop(id);
            src.loop = true;
            this.looping.set(id, { src, gain });
        }
        src.start();
        if(!loop) {
            src.onended = () => {
                src.disconnect();
                gain.disconnect();
            };
        }
        return src;
    }

    stop(id) {
        const loop = this.looping.get(id);
        if(loop) {
            loop.src.stop();
            loop.src.disconnect();
            loop.gain.disconnect();
            this.looping.delete(id);
        }
    }
}

const sounds = new SoundManager();

function createToneBuffer(ctx, {
    frequency = 440,
    endFrequency = null,
    duration = 0.2,
    type = 'sine',
    attack = 0.01,
    release = 0.05,
    volume = 0.8,
    noise = false
} = {}) {
    const sr = ctx.sampleRate;
    const driveAmt = Math.max(0.0001, drive);
    const len = Math.max(1, Math.floor(sr * duration));
    const buffer = ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);
    let phase = 0;
    for(let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.min(1, i / Math.max(1, sr * attack)) * Math.min(1, (len - i) / Math.max(1, sr * release));
        const freq = endFrequency ? frequency + (endFrequency - frequency) * t : frequency;
        let sample;
        if(noise) {
            sample = (Math.random() * 2 - 1) * 0.7;
        } else {
            phase += 2 * Math.PI * freq / sr;
            switch(type) {
                case 'square': sample = Math.sign(Math.sin(phase)); break;
                case 'sawtooth': sample = 2 * (phase / (2 * Math.PI) % 1) - 1; break;
                case 'triangle': sample = Math.asin(Math.sin(phase)) * (2 / Math.PI); break;
                default: sample = Math.sin(phase); break;
            }
        }
        data[i] = sample * env * volume;
    }
    return buffer;
}

function createShapedNoiseBuffer(ctx, {
    duration = 0.2,
    attack = 0.01,
    release = 0.05,
    volume = 0.8,
    lowpass = 4000,
    highpass = 120,
    drive = 1.2
} = {}) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * duration));
    const buffer = ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);
    const lpCoeff = Math.exp(-2 * Math.PI * lowpass / sr);
    const hpCoeff = Math.exp(-2 * Math.PI * highpass / sr);
    let lpState = 0;
    let hpState = 0;
    for(let i = 0; i < len; i++) {
        const env = Math.min(1, i / Math.max(1, sr * attack)) * Math.min(1, (len - i) / Math.max(1, sr * release));
        const white = Math.random() * 2 - 1;
        hpState += (white - hpState) * (1 - hpCoeff);
        const highPassed = white - hpState;
        lpState += (highPassed - lpState) * (1 - lpCoeff);
        const shaped = Math.tanh(lpState * driveAmt) / Math.tanh(driveAmt);
        data[i] = shaped * env * volume;
    }
    return buffer;
}

function concatBuffers(ctx, parts) {
    const totalLength = parts.reduce((sum, buf) => sum + buf.length, 0);
    const buffer = ctx.createBuffer(1, totalLength, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    let offset = 0;
    for(const part of parts) {
        out.set(part.getChannelData(0), offset);
        offset += part.length;
    }
    return buffer;
}

function mixBuffers(ctx, parts) {
    const length = Math.max(...parts.map((buf) => buf.length));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    for(const part of parts) {
        const data = part.getChannelData(0);
        for(let i = 0; i < part.length; i++) out[i] += data[i];
    }
    return buffer;
}

const SOUND_MANIFEST = {
    uiClick: (ctx) => createToneBuffer(ctx, { frequency: 1300, duration: 0.07, type: 'square', attack: 0.005, release: 0.06, volume: 0.35 }),
    uiHover: (ctx) => createToneBuffer(ctx, { frequency: 650, duration: 0.12, type: 'triangle', attack: 0.01, release: 0.08, volume: 0.3 }),
    start: (ctx) => concatBuffers(ctx, [
        createToneBuffer(ctx, { frequency: 440, endFrequency: 660, duration: 0.18, type: 'sawtooth', attack: 0.01, release: 0.07, volume: 0.35 }),
        createToneBuffer(ctx, { frequency: 990, duration: 0.15, type: 'triangle', attack: 0.005, release: 0.08, volume: 0.25 })
    ]),
    bullet: (ctx) => mixBuffers(ctx, [
        createShapedNoiseBuffer(ctx, { duration: 0.07, attack: 0.0006, release: 0.045, volume: 0.6, highpass: 900, lowpass: 5200, drive: 1.8 }), // muzzle blast
        createToneBuffer(ctx, { frequency: 4200, endFrequency: 1200, duration: 0.04, type: 'sawtooth', attack: 0.0008, release: 0.022, volume: 0.22 }), // supersonic crack
        createToneBuffer(ctx, { frequency: 140, endFrequency: 95, duration: 0.09, type: 'triangle', attack: 0.002, release: 0.07, volume: 0.3 }) // low-body thump
    ]),
    missile: (ctx) => mixBuffers(ctx, [
        createShapedNoiseBuffer(ctx, { duration: 0.65, attack: 0.02, release: 0.16, volume: 0.55, highpass: 80, lowpass: 1800, drive: 1.6 }), // exhaust roar
        createToneBuffer(ctx, { frequency: 520, endFrequency: 340, duration: 0.5, type: 'triangle', attack: 0.01, release: 0.1, volume: 0.22 }), // turbine whine
        createToneBuffer(ctx, { frequency: 180, endFrequency: 130, duration: 0.65, type: 'sawtooth', attack: 0.015, release: 0.14, volume: 0.25 }) // low rumble
    ]),
    lock: (ctx) => createToneBuffer(ctx, { frequency: 840, duration: 0.14, type: 'square', attack: 0.004, release: 0.08, volume: 0.32 }),
    hit: (ctx) => mixBuffers(ctx, [
        createShapedNoiseBuffer(ctx, { duration: 0.14, attack: 0.0015, release: 0.11, volume: 0.6, highpass: 180, lowpass: 2600, drive: 1.5 }),
        createToneBuffer(ctx, { frequency: 420, endFrequency: 210, duration: 0.1, type: 'triangle', attack: 0.004, release: 0.08, volume: 0.24 }),
        createToneBuffer(ctx, { frequency: 1600, endFrequency: 900, duration: 0.05, type: 'square', attack: 0.001, release: 0.04, volume: 0.14 })
    ]),
    alert: (ctx) => createToneBuffer(ctx, { frequency: 760, duration: 0.35, type: 'square', attack: 0.01, release: 0.2, volume: 0.25 }),
    explosion: (ctx) => mixBuffers(ctx, [
        createShapedNoiseBuffer(ctx, { duration: 0.55, attack: 0.006, release: 0.32, volume: 0.62, highpass: 70, lowpass: 2400, drive: 1.8 }),
        createToneBuffer(ctx, { frequency: 110, endFrequency: 55, duration: 0.42, type: 'sawtooth', attack: 0.01, release: 0.24, volume: 0.3 }),
        createToneBuffer(ctx, { frequency: 240, endFrequency: 120, duration: 0.26, type: 'triangle', attack: 0.006, release: 0.14, volume: 0.22 })
    ]),
    result: (ctx) => concatBuffers(ctx, [
        createToneBuffer(ctx, { frequency: 740, duration: 0.18, type: 'triangle', attack: 0.01, release: 0.08, volume: 0.35 }),
        createToneBuffer(ctx, { frequency: 880, duration: 0.2, type: 'triangle', attack: 0.01, release: 0.12, volume: 0.35 }),
        createToneBuffer(ctx, { frequency: 990, duration: 0.24, type: 'triangle', attack: 0.01, release: 0.12, volume: 0.35 })
    ])
};

// Globals
let scene, camera, renderer;
let player, environmentMesh, obstacles = [];
let bullets = [], missiles = [], enemies = [], particles = [];
let keys = { w: false, s: false, a: false, d: false, space: false };
let mouse = { x: 0, y: 0, isDown: false };

let isPlaying = false;
let currentStage = 'OCEAN';
let score = 0, armor = 100, missileCount = CONFIG.missileCapacity;
let lastShotTime = 0, lastMissileTime = 0, missileReloadEndTime = null;
let muzzleFlashLight;
const scoreListKey = 'aceWingHighScores';
let missileAlerting = false;

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
    markersLayer: document.getElementById('markers-layer')
};
const screens = {
    title: document.getElementById('title-screen'),
    world: document.getElementById('world-screen'),
    result: document.getElementById('result-screen')
};
const menuActions = {
    enterWorld: document.getElementById('enter-world-select'),
    titleToWorld: document.getElementById('title-to-world'),
    worldToTitle: document.getElementById('world-to-title'),
    retry: document.getElementById('retry-btn'),
    resultToWorld: document.getElementById('result-to-world'),
    resultToTitle: document.getElementById('result-to-title')
};
const resultUI = {
    score: document.getElementById('result-score'),
    rank: document.getElementById('result-rank')
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

    sounds.loadAll(SOUND_MANIFEST);

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
    if(menuActions.worldToTitle) menuActions.worldToTitle.addEventListener('click', () => setScreen('title'));
    if(menuActions.retry) menuActions.retry.addEventListener('click', () => startGame(currentStage));
    if(menuActions.resultToWorld) menuActions.resultToWorld.addEventListener('click', () => setScreen('world'));
    if(menuActions.resultToTitle) menuActions.resultToTitle.addEventListener('click', () => setScreen('title'));
    document.querySelectorAll('[data-stage]').forEach(btn => {
        btn.addEventListener('click', () => startGame(btn.dataset.stage));
    });
    document.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('pointerenter', () => sounds.play('uiHover', { volume: 0.3 }));
        btn.addEventListener('click', () => sounds.play('uiClick', { volume: 0.35 }));
    });

    setScreen('title');
}

function startGame(stage) {
    currentStage = stage;
    isPlaying = true;
    score = 0; armor = 100; missileCount = CONFIG.missileCapacity; missileReloadEndTime = null;
    missileAlerting = false;
    sounds.stop('alert');
    sounds.play('start', { volume: 0.5 });
    
    while(scene.children.length > 0) scene.remove(scene.children[0]);
    bullets = []; missiles = []; enemies = []; particles = []; obstacles = [];
    ui.markersLayer.innerHTML = ''; 

    setupEnvironment(stage);
    
    player = createPlayer();
    scene.add(player.mesh);
    player.mesh.position.set(0, 50, 0);

    // Muzzle Flash Effect Setup
    muzzleFlashLight = new THREE.PointLight(0xffffaa, 0, 20); // Initially 0 intensity
    player.mesh.add(muzzleFlashLight);
    muzzleFlashLight.position.set(0, 0, -3); // Near noise

    updateUI();
    setScreen('playing');
    ui.gameOverMsg.style.display = 'none';

    for(let i=0; i<10; i++) spawnEnemy();
    
    animate();
}

function gameOver() {
    if(!isPlaying) return;
    isPlaying = false;
    saveScore(score);
    updateHighScoreDisplay();
    sounds.stop('alert');
    missileAlerting = false;

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
    sounds.play('result', { volume: 0.5 });
    setScreen('result');
}

// --- Mechanics ---
function fireBullet(source, isEnemy) {
    const now = Date.now();
    if(!isEnemy) {
        // Rate limit check handled in animate loop for player
        sounds.play('bullet', { volume: 0.5, playbackRate: 0.9 + Math.random() * 0.16 });
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
    b.position.copy(source.mesh.position);
    
    // Adjust spawn pos slightly
    b.position.y -= 0.2; 
    
    b.quaternion.copy(source.mesh.quaternion);
    b.translateZ(-2);
    scene.add(b);
    bullets.push({ mesh: b, life: 80, isEnemy: isEnemy });

    // Visuals
    if(!isEnemy) {
        // Flash ON
        muzzleFlashLight.intensity = 5.0;
        setTimeout(() => { muzzleFlashLight.intensity = 0; }, 50); // Flash off quickly
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

function createPlayer() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x607d8b, roughness: 0.6, flatShading: true });
    const cockpitMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.2, emissive: 0xffb300, emissiveIntensity: 0.2 });
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
    
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3, 8), new THREE.MeshBasicMaterial({color:0x00ffff, transparent:true, opacity:0.8}));
    flame.rotateX(-Math.PI/2); flame.position.z = 4; group.add(flame);
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

function spawnEnemy() {
    const e = createEnemy();
    const angle = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 200;
    e.mesh.position.set(player.mesh.position.x + Math.cos(angle)*dist, 50, player.mesh.position.z + Math.sin(angle)*dist);
    scene.add(e.mesh);
    enemies.push(e);
    
    const marker = document.createElement('div');
    marker.className = 'enemy-marker';
    marker.innerHTML = `<span class="marker-dist">0m</span>`;
    ui.markersLayer.appendChild(marker);
    e.marker = marker;
}

function startMissileReload() {
    if(missileReloadEndTime || !isPlaying) return;
    missileReloadEndTime = Date.now() + CONFIG.missileReloadTimeMs;
}

function fireMissile(source, isEnemy) {
    if(!isEnemy) {
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
        const pDir = new THREE.Vector3(0,0,-1).applyQuaternion(player.mesh.quaternion);
        enemies.forEach(e => {
            const toE = new THREE.Vector3().subVectors(e.mesh.position, player.mesh.position).normalize();
            const a = pDir.angleTo(toE);
            if(a < minAngle) { target = e; minAngle = a; }
        });
        if(target) {
            showMessage("FOX 2", 800);
            sounds.play('lock', { volume: 0.35 });
        }
    }
    if(!isEnemy) sounds.play('missile', { volume: 0.6, playbackRate: 0.94 + Math.random() * 0.12 });
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
    m.position.copy(source.mesh.position); m.position.y -= 0.5;
    m.quaternion.copy(source.mesh.quaternion);
    scene.add(m);
    const missileSpeed = player.speed * CONFIG.missileSpeedMultiplier;
    missiles.push({ mesh: m, target: target, life: 300, speed: missileSpeed, isEnemy: isEnemy });
}

function createExplosion(pos, scale) {
    sounds.play('explosion', { volume: Math.min(0.8, 0.3 + scale * 0.15), playbackRate: 0.92 + Math.random() * 0.16 });
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
                if(p.mesh.position.distanceTo(player.mesh.position) < 2) { hit = true; armor -= 10; createExplosion(p.mesh.position, 1); sounds.play('hit', { volume: 0.55, playbackRate: 0.9 + Math.random() * 0.2 }); }
            } else {
                for(let j=enemies.length-1; j>=0; j--) {
                    if(p.mesh.position.distanceTo(enemies[j].mesh.position) < 3) {
                        hit = true; createExplosion(enemies[j].mesh.position, 3);
                        if(enemies[j].marker) enemies[j].marker.remove();
                        scene.remove(enemies[j].mesh); enemies.splice(j, 1);
                        score += 100; setTimeout(spawnEnemy, 2000);
                    }
                }
            }
            for(let o of obstacles) if(p.mesh.position.distanceTo(o.position) < o.scale.y/2) hit = true;
            if(hit || p.life<=0) { scene.remove(p.mesh); arr.splice(i,1); }
        }
    });

    // Enemies (RELAXED ATTACK LOGIC)
    let alert = false;
    for(let i=enemies.length-1; i>=0; i--) {
        const e = enemies[i];
        const toP = new THREE.Vector3().subVectors(player.mesh.position, e.mesh.position);
        const dist = toP.length();

        if(dist > 2500) {
            if(e.marker) e.marker.remove(); scene.remove(e.mesh); enemies.splice(i, 1); spawnEnemy(); continue;
        }

        toP.y = 0; toP.normalize();
        e.mesh.position.y = 50; e.mesh.rotation.x = 0; e.mesh.rotation.z = 0;
        e.mesh.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.atan2(toP.x, toP.z)+Math.PI), 0.03);
        e.mesh.translateZ(e.speed);

        // Attack logic: Removed strict angle check. Now just distance check.
        // Will shoot if somewhat close, regardless of angle, to ensure activity.
        if(dist < 800) {
             const now = Date.now();
             // High chance to shoot if close
             if(now - (e.lastShot||0) > 1000) { fireBullet(e, true); e.lastShot = now; }
             if(Math.random() < 0.005 && dist > 100) fireMissile(e, true);
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

    // Particles
    for(let i=particles.length-1; i>=0; i--) {
        const p = particles[i]; p.mesh.position.add(p.vel); p.life--; p.mesh.scale.multiplyScalar(0.95); p.mesh.material.opacity = p.life/p.maxLife;
        if(p.life<=0) { scene.remove(p.mesh); particles.splice(i,1); }
    }

    // Radar
    while(ui.radar.children.length>0) ui.radar.removeChild(ui.radar.lastChild);
    // Player center dot
    let pd = document.createElement('div'); pd.className='radar-player'; ui.radar.appendChild(pd);
    for(let e of enemies) {
         const rel = e.mesh.position.clone().sub(player.mesh.position); rel.applyAxisAngle(new THREE.Vector3(0,1,0), -player.mesh.rotation.y);
         let rx=rel.x*0.5, rz=rel.z*0.5, rd=Math.sqrt(rx*rx+rz*rz); if(rd>80){rx*=80/rd;rz*=80/rd;}
         const d=document.createElement('div'); d.className='radar-dot'; d.style.left=(80+rx)+'px'; d.style.top=(80+rz)+'px'; ui.radar.appendChild(d);
    }
    for(let m of missiles) if(m.isEnemy) alert = true;
    ui.alert.style.display = alert ? 'block' : 'none';
    if(alert && !missileAlerting) {
        missileAlerting = true;
        sounds.play('alert', { volume: 0.35, loop: true });
    } else if(!alert && missileAlerting) {
        sounds.stop('alert');
        missileAlerting = false;
    }

    if(armor <= 0) gameOver();
    updateUI();
    renderer.render(scene, camera);
}

init();
animate(); // Start loop for menu bg
