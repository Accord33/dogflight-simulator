const CONFIG = {
    playerSpeedMin: 0.25,
    playerSpeedMax: 1.6,
    turnSpeed: 0.01,
    pitchLimit: 0.5,
    rollLimit: 0.9,
    throttleAccel: 0.4,
    drag: 0.015,
    stallSpeed: 0.35,
    stallAngle: 0.35,
    bulletSpeed: 6.5, 
    missileSpeedMultiplier: 1.35, // Missiles move at ~1.35x the player's current speed
    lockCone: 0.35,
    lockRange: 1400,
    lockTimeMs: 1200,
    altitudeMin: -20,
    altitudeMax: 400,
    missileCapacity: 20,
    missileReloadTimeMs: 30000, // 30s reload when missiles are depleted
    enemySpeed: 0.55,
    seaSize: 2000,
    fireRate: 70 // ms between shots
};

// Globals
let scene, camera, renderer;
let player, environmentMesh, obstacles = [];
let bullets = [], missiles = [], enemies = [], particles = [];
let keys = { w: false, s: false, a: false, d: false, q: false, e: false, space: false };
let mouse = { x: 0, y: 0, isDown: false };
const SPAWN_SAFE_RADIUS = 280;

let isPlaying = false;
let currentStage = 'OCEAN';
let score = 0, armor = 100, missileCount = CONFIG.missileCapacity;
let lastShotTime = 0, lastMissileTime = 0, missileReloadEndTime = null;
let spawnShieldEndTime = 0;
let lockState = { target: null, progress: 0 };
let muzzleFlashLight;
let cameraVelocity = new THREE.Vector3();
let lastFrameTime = performance.now();
const scoreListKey = 'aceWingHighScores';

// UI Refs
const ui = {
    score: document.getElementById('score-val'),
    throttle: document.getElementById('throttle-val'),
    altitude: document.getElementById('alt-val'),
    hpBar: document.getElementById('hp-bar-fill'),
    missile: document.getElementById('missile-val'),
    radar: document.getElementById('radar-container'),
    alert: document.getElementById('missile-alert'),
    msg: document.getElementById('message-area'),
    menu: document.getElementById('menu-overlay'),
    gameOverMsg: document.getElementById('game-over-msg'),
    highScoreList: document.getElementById('highscore-list'),
    markersLayer: document.getElementById('markers-layer'),
    lockIndicator: document.getElementById('lock-indicator'),
    lockProgress: document.getElementById('lock-progress')
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

    setScreen('title');
}

function startGame(stage) {
    currentStage = stage;
    isPlaying = true;
    score = 0; armor = 100; missileCount = CONFIG.missileCapacity; missileReloadEndTime = null;
    lockState = { target: null, progress: 0 };
    spawnShieldEndTime = Date.now() + 2500;
    cameraVelocity.set(0,0,0);
    lastFrameTime = performance.now();
    
    while(scene.children.length > 0) scene.remove(scene.children[0]);
    bullets = []; missiles = []; enemies = []; particles = []; obstacles = [];
    environmentMesh = null;
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

function pushOutsideSafeZone(vec, padding=180) {
    const r = Math.hypot(vec.x, vec.z);
    if(r < SPAWN_SAFE_RADIUS) {
        const angle = Math.atan2(vec.z, vec.x) || (Math.random() * Math.PI * 2);
        const newR = SPAWN_SAFE_RADIUS + padding + Math.random() * 220;
        vec.x = Math.cos(angle) * newR;
        vec.z = Math.sin(angle) * newR;
    }
}

function isSpawnShieldActive() {
    return isPlaying && Date.now() < spawnShieldEndTime;
}

// --- Mechanics ---
function fireBullet(source, isEnemy) {
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
    const ambient = new THREE.HemisphereLight(0xb0c6ff, 0x0d1320, 0.8);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff3d2, 1.1);
    sun.position.set(120, 220, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);

    if (stage === 'OCEAN') {
        scene.background = new THREE.Color(0x7db9e8);
        scene.fog = new THREE.Fog(0x7db9e8, 200, 1200);
        createOcean();
        createClouds(0xffffff, 50);
        createCarrierGroup();
    } else if (stage === 'CITY') {
        scene.background = new THREE.Color(0x050510);
        scene.fog = new THREE.FogExp2(0x050510, 0.002);
        createCityGround();
        createBuildings();
        createNeonSkyTraffic();
    } else if (stage === 'WASTELAND') {
        scene.background = new THREE.Color(0xcc9966);
        scene.fog = new THREE.FogExp2(0xcc9966, 0.0025);
        createWasteland();
        createRocks();
        createWrecks();
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
        const pos = new THREE.Vector3((Math.random()-0.5)*1200, h/2 - 2, (Math.random()-0.5)*1200);
        pushOutsideSafeZone(pos, 260);
        building.position.copy(pos);
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
        const pos = new THREE.Vector3((Math.random()-0.5)*1200, -10+Math.random()*10, (Math.random()-0.5)*1200);
        pushOutsideSafeZone(pos, 220);
        rock.position.copy(pos);
        rock.scale.set(s, s*1.5, s);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        scene.add(rock);
        obstacles.push(rock);
    }
}

function createCarrierGroup() {
    const basePos = new THREE.Vector3(-220, -4, 260);
    pushOutsideSafeZone(basePos, 320);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(80, 8, 260), new THREE.MeshStandardMaterial({ color: 0x1c1f26, metalness: 0.2, roughness: 0.7 }));
    deck.position.copy(basePos).add(new THREE.Vector3(0, -2, 0));
    scene.add(deck); obstacles.push(deck);

    const island = new THREE.Mesh(new THREE.BoxGeometry(18, 30, 24), new THREE.MeshStandardMaterial({ color: 0x222a33, emissive: 0x112233, metalness: 0.3 }));
    island.position.copy(basePos).add(new THREE.Vector3(-18, 10, 30));
    const towerLight = new THREE.PointLight(0x66aaff, 2, 120);
    towerLight.position.set(-18, 22, 30);
    island.add(towerLight);
    scene.add(island); obstacles.push(island);

    for(let i=0; i<3; i++) {
        const escortPos = basePos.clone().add(new THREE.Vector3(-100 + i*70, -2, -80 + i*50));
        pushOutsideSafeZone(escortPos, 280);
        const escort = new THREE.Mesh(new THREE.BoxGeometry(24, 6, 80), new THREE.MeshStandardMaterial({ color: 0x223344, metalness: 0.2, roughness: 0.6 }));
        escort.position.copy(escortPos);
        scene.add(escort); obstacles.push(escort);
    }
}

function createNeonSkyTraffic() {
    for(let i=0; i<8; i++) {
        const path = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 180, 6), new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent:true, opacity:0.25 }));
        path.position.set((Math.random()-0.5)*800, 80 + Math.random()*120, (Math.random()-0.5)*800);
        path.rotation.x = Math.PI/2;
        scene.add(path);
        const beacon = new THREE.PointLight(0x00ccff, 1.5, 180);
        beacon.position.copy(path.position).add(new THREE.Vector3(0, 0, -80));
        scene.add(beacon);
    }
}

function createWrecks() {
    for(let i=0; i<10; i++) {
        const hull = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 22), new THREE.MeshStandardMaterial({ color: 0x4b2f24, roughness: 1, metalness: 0.05 }));
        const pos = new THREE.Vector3((Math.random()-0.5)*1000, -8 + Math.random()*4, (Math.random()-0.5)*1000);
        pushOutsideSafeZone(pos, 240);
        hull.position.copy(pos);
        hull.rotation.set(Math.random()*0.2, Math.random()*Math.PI, Math.random()*0.2);
        scene.add(hull); obstacles.push(hull);
    }
}

function createPlayer() {
    const group = new THREE.Group();
    group.name = 'player';
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x607d8b, roughness: 0.55, metalness: 0.15, flatShading: true });
    const cockpitMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.2, emissive: 0xffb300, emissiveIntensity: 0.35 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4, 6), bodyMat);
    body.rotateX(Math.PI / 2); group.add(body);
    const engine = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 2), bodyMat);
    engine.position.z = 1.5; group.add(engine);
    const cockpit = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), cockpitMat);
    cockpit.scale.set(1, 0.6, 2); cockpit.position.set(0, 0.4, -0.2); group.add(cockpit);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.4, 2), bodyMat);
    tail.position.set(0, 1.1, 1.4); tail.rotation.x = Math.PI / 16; group.add(tail);
    
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0,0); wingShape.lineTo(2.5,1.5); wingShape.lineTo(2.5,2.5); wingShape.lineTo(0,1.5);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, {steps:1, depth:0.1, bevelEnabled:false});
    wingGeo.center();
    const lWing = new THREE.Mesh(wingGeo, bodyMat);
    lWing.rotation.x = Math.PI/2; lWing.rotation.z = -Math.PI/2; lWing.position.set(-1.4,0,0.5); group.add(lWing);
    const rWing = lWing.clone(); rWing.rotation.z = Math.PI/2; rWing.rotation.y = Math.PI; rWing.position.set(1.4,0,0.5); group.add(rWing);
    
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3, 8), new THREE.MeshBasicMaterial({color:0x00ffff, transparent:true, opacity:0.8}));
    flame.rotateX(-Math.PI/2); flame.position.z = 4; group.add(flame);
    const wingLightGeo = new THREE.SphereGeometry(0.12, 6, 6);
    const wingLightMatL = new THREE.MeshStandardMaterial({ color: 0x00aaff, emissive: 0x00aaff, emissiveIntensity: 1.2, roughness: 0.6 });
    const wingLightMatR = new THREE.MeshStandardMaterial({ color: 0xff2255, emissive: 0xff2255, emissiveIntensity: 1.2, roughness: 0.6 });
    const wingLightL = new THREE.Mesh(wingLightGeo, wingLightMatL);
    const wingLightR = new THREE.Mesh(wingLightGeo, wingLightMatR);
    wingLightL.position.set(-2.2, 0.2, 0.6); wingLightR.position.set(2.2, 0.2, 0.6);
    group.add(wingLightL); group.add(wingLightR);

    return { 
        mesh: group, 
        speed: CONFIG.playerSpeedMin, 
        throttle: 0.6,
        pitch: 0,
        yaw: 0,
        roll: 0,
        stallWarning: 0,
        flame: flame
    };
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
    const vent = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.5, 8), new THREE.MeshBasicMaterial({ color: 0xff6633, transparent: true, opacity: 0.6 }));
    vent.rotation.x = -Math.PI / 2;
    vent.position.z = 3.5;
    group.add(vent);
    return { 
        mesh: group, 
        speed: CONFIG.enemySpeed + Math.random()*0.2, 
        lastShot: 0,
        state: 'intercept',
        stateTimer: 2 + Math.random()*3,
        turnBias: Math.random()>0.5 ? 1 : -1
    };
}

function spawnEnemy() {
    const e = createEnemy();
    const angle = Math.random() * Math.PI * 2;
    const dist = 320 + Math.random() * 280;
    e.mesh.position.set(player.mesh.position.x + Math.cos(angle)*dist, 50, player.mesh.position.z + Math.sin(angle)*dist);
    e.lastShot = Date.now() + 1400 + Math.random()*1000; // Delay first volley
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
        if(!lockState.target || lockState.progress < 1) { showMessage("LOCK REQUIRED", 600); return; }
        if(missileCount <= 0 || !isPlaying) return;
        const now = Date.now();
        if(now - lastMissileTime < 1000) return;
        lastMissileTime = now;
        missileCount--;
        if(missileCount === 0) startMissileReload();
        updateUI();
    }
    let target = isEnemy ? player : lockState.target;
    if(!isEnemy && target) { showMessage("FOX 2", 800); lockState.progress = 0; }
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
    const baseSpeed = source.speed || CONFIG.playerSpeedMin;
    const missileSpeed = baseSpeed * CONFIG.missileSpeedMultiplier;
    missiles.push({ mesh: m, target: target, life: 300, speed: missileSpeed, isEnemy: isEnemy });
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
    if(ui.throttle) ui.throttle.innerText = `${Math.round(player.throttle*100)}%`;
    if(ui.altitude) ui.altitude.innerText = `${Math.max(0, Math.floor(player.mesh.position.y+10))}m`;
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

function applyCameraSpring(forwardDir, frameScale) {
    const camOffset = new THREE.Vector3(0, 6, 18).applyEuler(new THREE.Euler(player.pitch * 0.2, player.yaw, player.roll * 0.3, 'XYZ'));
    const targetPos = player.mesh.position.clone().add(camOffset);
    const stiffness = 0.08 * frameScale;
    cameraVelocity.add(targetPos.clone().sub(camera.position).multiplyScalar(stiffness));
    cameraVelocity.multiplyScalar(0.92);
    camera.position.add(cameraVelocity);
    const lookPos = player.mesh.position.clone().add(forwardDir.clone().multiplyScalar(30));
    camera.lookAt(lookPos);
}

function updateEnvironment(frameScale, now) {
    if(environmentMesh) {
        const dx = player.mesh.position.x - environmentMesh.position.x;
        const dz = player.mesh.position.z - environmentMesh.position.z;
        if(Math.abs(dx) > 120) environmentMesh.position.x += dx;
        if(Math.abs(dz) > 120) environmentMesh.position.z += dz;
        if(currentStage === 'OCEAN') {
            const pos = environmentMesh.geometry.attributes.position;
            const t = now * 0.0012;
            for(let i=0; i<pos.count; i+=2) pos.setY(i, Math.sin(t + i*0.15) * 2.4 + Math.cos(t*0.5 + i*0.05));
            pos.needsUpdate = true;
        }
    }

    if(currentStage === 'WASTELAND') {
        if(Math.random() < 0.15 * frameScale) {
            const base = player.mesh.position.clone();
            base.y = -5 + Math.random()*5;
            spawnDust(base, 1.5 + Math.random());
        }
    }
}

function spawnDust(position, scale) {
    const geo = new THREE.SphereGeometry(0.6, 5, 5);
    const mat = new THREE.MeshBasicMaterial({ color: 0xdcc5a1, transparent: true, opacity: 0.25 });
    const puff = new THREE.Mesh(geo, mat);
    puff.position.copy(position);
    puff.scale.setScalar(scale);
    scene.add(puff);
    particles.push({ mesh: puff, vel: new THREE.Vector3((Math.random()-0.5)*0.2, 0.05, (Math.random()-0.5)*0.2), life: 30, maxLife: 30 });
}

function updateLockOn(dt) {
    if(!player) return;
    if(lockState.target && !enemies.includes(lockState.target)) lockState = { target: null, progress: 0 };
    const forward = new THREE.Vector3(0,0,-1).applyQuaternion(player.mesh.quaternion);
    let best = null; let bestAngle = CONFIG.lockCone;
    for(let e of enemies) {
        const toE = new THREE.Vector3().subVectors(e.mesh.position, player.mesh.position);
        const dist = toE.length();
        if(dist > CONFIG.lockRange) continue;
        const a = forward.angleTo(toE.normalize());
        if(a < bestAngle) { best = e; bestAngle = a; }
    }
    if(best && lockState.target === best) {
        lockState.progress = Math.min(1, lockState.progress + (dt * 1000 / CONFIG.lockTimeMs));
    } else if(best) {
        lockState = { target: best, progress: 0 };
    } else {
        lockState.progress = Math.max(0, lockState.progress - dt * 2);
        if(lockState.progress === 0) lockState.target = null;
    }

    if(ui.lockIndicator && ui.lockProgress) {
        ui.lockIndicator.style.display = lockState.target ? 'flex' : 'flex';
        ui.lockProgress.innerText = lockState.target ? `${Math.floor(lockState.progress*100)}%` : 'NO TARGET';
        ui.lockIndicator.classList.toggle('locked', lockState.progress >= 1);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    const frameScale = dt * 60; // normalize to ~60fps
    lastFrameTime = now;

    if(!player) { renderer.render(scene, camera); return; }
    if(!isPlaying) { renderer.render(scene, camera); return; }

    // --- 1. CONTINUOUS FIRE LOGIC ---
    if(mouse.isDown) {
        const fireNow = Date.now();
        if(fireNow - lastShotTime > CONFIG.fireRate) {
            fireBullet(player, false);
            lastShotTime = fireNow;
        }
    }

    // --- 2. FLIGHT MODEL ---
    const throttleInput = (keys.w ? 1 : 0) + (keys.s ? -1 : 0);
    player.throttle = THREE.MathUtils.clamp(player.throttle + throttleInput * CONFIG.throttleAccel * dt, 0, 1);
    const targetSpeed = CONFIG.playerSpeedMin + player.throttle * (CONFIG.playerSpeedMax - CONFIG.playerSpeedMin);
    player.speed += (targetSpeed - player.speed) * 0.12 * frameScale;
    player.speed = Math.max(CONFIG.playerSpeedMin * 0.5, player.speed - CONFIG.drag * frameScale * (1 + Math.abs(player.pitch)*0.3));

    const turn = (keys.a ? 1 : 0) + (keys.d ? -1 : 0);
    const rollInput = (keys.q ? 1 : 0) + (keys.e ? -1 : 0) + turn * 0.6;
    player.yaw += turn * CONFIG.turnSpeed * frameScale * (0.6 + player.speed * 0.5);
    const targetRoll = THREE.MathUtils.clamp(-rollInput * CONFIG.rollLimit + mouse.x * 0.35, -CONFIG.rollLimit, CONFIG.rollLimit);
    player.roll += (targetRoll - player.roll) * 0.08 * frameScale;
    const targetPitch = THREE.MathUtils.clamp(mouse.y * CONFIG.pitchLimit, -CONFIG.pitchLimit, CONFIG.pitchLimit);
    player.pitch += (targetPitch - player.pitch) * 0.08 * frameScale;

    // Stall feedback
    const isStalling = player.speed < CONFIG.stallSpeed && Math.abs(player.pitch) > CONFIG.stallAngle;
    if(isStalling) {
        player.pitch += (-player.pitch) * 0.04 * frameScale;
        player.speed -= 0.01 * frameScale;
        player.stallWarning -= dt;
        if(player.stallWarning <= 0) { showMessage("STALL", 500); player.stallWarning = 0.8; }
    } else {
        player.stallWarning = Math.max(0, player.stallWarning - dt);
    }

    const moveVec = new THREE.Vector3(0,0,-player.speed * frameScale).applyEuler(new THREE.Euler(player.pitch, player.yaw, player.roll, 'XYZ'));
    player.mesh.position.add(moveVec);
    player.mesh.rotation.set(player.pitch, player.yaw, player.roll);
    player.mesh.position.y = THREE.MathUtils.clamp(player.mesh.position.y, CONFIG.altitudeMin, CONFIG.altitudeMax);
    player.flame.scale.z = 1 + player.throttle * 3.5;
    player.flame.material.opacity = 0.5 + player.throttle * 0.4;

    // Player collision with big obstacles
    for(let o of obstacles) {
        if(!o.geometry) continue;
        if(!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const r = o.geometry.boundingSphere.radius * Math.max(o.scale.x||1, o.scale.y||1, o.scale.z||1);
        if(player.mesh.position.distanceTo(o.position) < r * 0.8) {
            if(!isSpawnShieldActive()) {
                armor -= 25 * dt * 60;
                showMessage("PULL UP", 400);
            }
        }
    }

    applyCameraSpring(moveVec.clone().normalize(), frameScale);
    updateEnvironment(frameScale, now);

    if(missileReloadEndTime && Date.now() >= missileReloadEndTime) {
        missileCount = CONFIG.missileCapacity;
        missileReloadEndTime = null;
        showMessage("MISSILES READY", 1000);
    }

    updateLockOn(dt);

    // --- 3. PROJECTILES ---
    [bullets, missiles].forEach(arr => {
        for(let i=arr.length-1; i>=0; i--) {
            const p = arr[i];
            const travel = ((p.speed)||CONFIG.bulletSpeed) * frameScale;
            p.mesh.translateZ(-travel);
            p.life -= frameScale;
            if(p.target && p.target.mesh) {
                 const toT = new THREE.Vector3().subVectors(p.target.mesh.position, p.mesh.position).normalize();
                 const f = new THREE.Vector3(0,0,-1).applyQuaternion(p.mesh.quaternion);
                 if(f.angleTo(toT) < Math.PI/3) p.mesh.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), toT), 0.05);
            }
            if(arr === missiles && Math.floor(p.life) % 2 === 0) {
                const t = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.3), new THREE.MeshBasicMaterial({color:0xcccccc, transparent:true, opacity:0.4}));
                t.position.copy(p.mesh.position).add(new THREE.Vector3((Math.random()-.5)*.2,(Math.random()-.5)*.2,(Math.random()-.5)*.2));
                scene.add(t); particles.push({mesh:t, vel:new THREE.Vector3(0,0,0), life:15, maxLife:15});
            }
            if(arr === bullets && !p.isEnemy && Math.floor(p.life) % 2 === 0) {
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
                if(p.mesh.position.distanceTo(player.mesh.position) < 2.5) { 
                    hit = true; 
                    if(!isSpawnShieldActive()) armor -= 10; 
                    createExplosion(p.mesh.position, 1); 
                }
            } else {
                for(let j=enemies.length-1; j>=0; j--) {
                    if(p.mesh.position.distanceTo(enemies[j].mesh.position) < 3) {
                        hit = true; createExplosion(enemies[j].mesh.position, 3);
                        if(enemies[j].marker) enemies[j].marker.remove();
                        if(lockState.target === enemies[j]) lockState = { target: null, progress: 0 };
                        scene.remove(enemies[j].mesh); enemies.splice(j, 1);
                        score += 120; setTimeout(spawnEnemy, 2000);
                    }
                }
            }
            for(let o of obstacles) if(p.mesh.position.distanceTo(o.position) < (o.scale?.y||2)/2) hit = true;
            if(hit || p.life<=0) { scene.remove(p.mesh); arr.splice(i,1); }
        }
    });

    // --- 4. ENEMIES ---
    let alert = false;
    for(let i=enemies.length-1; i>=0; i--) {
        const e = enemies[i];
        const toP = new THREE.Vector3().subVectors(player.mesh.position, e.mesh.position);
        const dist = toP.length();

        if(dist > 2600) {
            if(lockState.target === e) lockState = { target: null, progress: 0 };
            if(e.marker) e.marker.remove(); scene.remove(e.mesh); enemies.splice(i, 1); spawnEnemy(); continue;
        }

        e.stateTimer -= dt;
        if(dist < 200 && e.state === 'intercept') { e.state = 'break'; e.stateTimer = 2; }
        if(e.stateTimer <= 0) {
            e.state = e.state === 'intercept' ? 'circle' : 'intercept';
            e.stateTimer = 2 + Math.random()*3;
            e.turnBias *= -1;
        }

        toP.normalize();
        const desiredYaw = Math.atan2(toP.x, toP.z) + Math.PI;
        const currentYaw = e.mesh.rotation.y || 0;
        let delta = desiredYaw - currentYaw;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        const yawStep = delta * 0.04 * frameScale + e.turnBias * 0.002 * frameScale;
        e.mesh.rotation.y += yawStep;
        e.mesh.rotation.z += (-yawStep*4 - e.mesh.rotation.z) * 0.1;
        e.mesh.rotation.x = 0;

        const enemySpeed = e.state === 'break' ? e.speed * 1.2 : e.speed;
        e.mesh.translateZ(enemySpeed * frameScale);
        e.mesh.position.y = 50 + Math.sin(now*0.001 + i) * 5;

        if(dist < 850) {
             const fireNow = Date.now();
             if(fireNow - (e.lastShot||0) > 900) { fireBullet(e, true); e.lastShot = fireNow; }
             if(Math.random() < 0.006 && dist > 120) fireMissile(e, true);
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

    // --- 5. PARTICLES ---
    for(let i=particles.length-1; i>=0; i--) {
        const p = particles[i]; p.mesh.position.add(p.vel); p.life -= frameScale; p.mesh.scale.multiplyScalar(0.95); p.mesh.material.opacity = p.life/p.maxLife;
        if(p.life<=0) { scene.remove(p.mesh); particles.splice(i,1); }
    }

    // --- 6. RADAR & ALERTS ---
    while(ui.radar.children.length>0) ui.radar.removeChild(ui.radar.lastChild);
    let pd = document.createElement('div'); pd.className='radar-player'; ui.radar.appendChild(pd);
    for(let e of enemies) {
         const rel = e.mesh.position.clone().sub(player.mesh.position); rel.applyAxisAngle(new THREE.Vector3(0,1,0), -player.yaw);
         let rx=rel.x*0.5, rz=rel.z*0.5, rd=Math.sqrt(rx*rx+rz*rz); if(rd>80){rx*=80/rd;rz*=80/rd;}
         const d=document.createElement('div'); d.className='radar-dot'; d.style.left=(80+rx)+'px'; d.style.top=(80+rz)+'px'; ui.radar.appendChild(d);
    }
    for(let m of missiles) if(m.isEnemy) alert = true;
    ui.alert.style.display = alert ? 'block' : 'none';

    if(armor <= 0) gameOver();
    updateUI();
    renderer.render(scene, camera);
}

init();
animate(); // Start loop for menu bg
