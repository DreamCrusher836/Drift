(function(){
"use strict";

/* ============================================================
   CANVAS SETUP
============================================================ */
const bgCanvas = document.getElementById('bgCanvas');
const mainCanvas = document.getElementById('mainCanvas');
const bgCtx = bgCanvas.getContext('2d');
const ctx = mainCanvas.getContext('2d');

let W = window.innerWidth, H = window.innerHeight;
let CX = W/2, CY = H/2; // screen center = ship position always

function resize(){
  W = window.innerWidth; H = window.innerHeight;
  CX = W/2; CY = H/2;
  bgCanvas.width = W; bgCanvas.height = H;
  mainCanvas.width = W; mainCanvas.height = H;
}
window.addEventListener('resize', resize);
resize();

/* ============================================================
   UTIL
============================================================ */
function rand(a,b){ return a + Math.random()*(b-a); }
function randInt(a,b){ return Math.floor(rand(a,b+1)); }
function dist2(x1,y1,x2,y2){ const dx=x1-x2, dy=y1-y2; return dx*dx+dy*dy; }
function angleTo(x1,y1,x2,y2){ return Math.atan2(y2-y1, x2-x1); }
function normalizeAngleDiff(a){
  while(a > Math.PI) a -= Math.PI*2;
  while(a < -Math.PI) a += Math.PI*2;
  return a;
}
function lerpAngle(from, to, t){
  const diff = normalizeAngleDiff(to - from);
  return from + diff * t;
}

/* ============================================================
   SPATIAL GRID — groups asteroids/enemies into world-space cells
   so collision and proximity checks only scan nearby entities
   instead of the entire list every time. Pure performance layer:
   it does not change any hit detection results, just how fast
   candidates are found before the existing circleHit/dist2 checks.
============================================================ */
const GRID_CELL_SIZE = 150;

function gridKey(cellX, cellY){
  return cellX + ',' + cellY;
}

function buildSpatialGrid(entityLists){
  const grid = new Map();
  for(const list of entityLists){
    for(const entity of list){
      const cx = Math.floor(entity.x / GRID_CELL_SIZE);
      const cy = Math.floor(entity.y / GRID_CELL_SIZE);
      const key = gridKey(cx, cy);
      let bucket = grid.get(key);
      if(!bucket){ bucket = []; grid.set(key, bucket); }
      bucket.push(entity);
    }
  }
  return grid;
}

// returns every entity in the cells overlapping a circle of given radius around (x,y)
function gridQuery(grid, x, y, radius){
  const results = [];
  const minCx = Math.floor((x-radius) / GRID_CELL_SIZE);
  const maxCx = Math.floor((x+radius) / GRID_CELL_SIZE);
  const minCy = Math.floor((y-radius) / GRID_CELL_SIZE);
  const maxCy = Math.floor((y+radius) / GRID_CELL_SIZE);
  for(let cx=minCx; cx<=maxCx; cx++){
    for(let cy=minCy; cy<=maxCy; cy++){
      const bucket = grid.get(gridKey(cx,cy));
      if(bucket){
        for(let i=0;i<bucket.length;i++) results.push(bucket[i]);
      }
    }
  }
  return results;
}

// frame-scoped grids: rebuilt once per frame in update(), read by any
// collision-related function called during that same frame (explosive
// impact, chain reactions, drone targeting) instead of each one
// building and scanning the full entity lists independently.
let asteroidGrid = null;
let enemyGrid = null;

/* ============================================================
   GAME STATE
============================================================ */
const STATE = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  UPGRADE: 'upgrade',
  DEAD: 'dead'
};
let gameState = STATE.MENU;

let score = 0;
let nextUpgradeAt = 1500;
let upgradeStep = 1500;
let waveLevel = 1;
let elapsedTime = 0;
let lastSpawnCheck = 0;

const keys = {};
let mouseX = CX, mouseY = CY;
let mouseDown = false;

/* world offset: how far the "camera" (i.e. the field) has shifted.
   Moving the ship right == shifting world left under it. */
let worldShiftX = 0, worldShiftY = 0;

/* ============================================================
   PLAYER
============================================================ */
const player = {
  angle: 0,
  vx: 0, vy: 0,
  speed: 0,
  maxSpeed: 4.4,
  accel: 0.32,
  friction: 0.965,
  radius: 14,
  lives: 3,
  maxLives: 5,
  invuln: 0,
  invulnDuration: 1100,  // ms of invulnerability granted after taking a real hit (Extended Recovery raises this)
  shieldCharge: 0,     // armor upgrade: absorbs hits
  shieldMax: 0,
  sparePartsChance: 0,  // 0-1, chance a hit that gets past the shield costs no life
  scoreBonusPct: 0,      // % bonus applied to all score gained (Scrap Collector)
  evasivePlatingBonus: 0, // 0-1, max damage reduction (as a fraction) scaled by current speed ratio
  afterburnDamage: 0,     // flat damage applied per tick to enemies within afterburnRadius while moving fast
  afterburnRadius: 0,
  afterburnTimer: 0,
  thrusterPulse: 0
};

/* weapon system */
const weapon = {
  fireRate: 230,      // ms between shots
  lastFire: 0,
  damage: 1,
  spread: 1,           // number of projectile lanes
  spreadAngle: 0.16,    // radians between lanes
  speed: 9.5,
  piercing: false,
  pierceDamageRetain: 0.7, // fraction of damage kept after passing through a target
  explosive: false,
  explosiveRadius: 55,
  projSize: 3,
  name: "PULSE CANNON",
  rapidLevel: 0,
  speedLevel: 0,
  chainReactor: false,
  chainChance: 0,
  chainRadius: 0,
  critChance: 0,        // 0-1, chance for a shot to land as a critical hit
  critMultiplier: 2.5,   // damage multiplier on a critical hit
  hullBreakerBonus: 0,   // % bonus damage (as a fraction) vs. Tanks, Captain, and Marksman
  slipstreamBonus: 0,    // 0-1, max fire-rate reduction (as a fraction) scaled by current speed ratio
  momentumBonus: 0,      // 0-1, max bonus damage (as a fraction) scaled by current speed ratio
  driftPierceBonus: 0    // 0-1, chance at top speed that a shot gains piercing for its flight
};

const ownedUpgrades = {}; // track counts per upgrade id, for display + stacking limits

/* ============================================================
   ABILITIES — a category separate from stat/mod upgrades.
   Spacebar is reserved exclusively for whichever ability the
   player currently has equipped (nothing happens if they have
   none). Designed so additional abilities can be added to
   ABILITY_POOL later without touching this state or the input
   wiring — only equippedAbilityId ever needs to change owners.
============================================================ */
const ownedAbilities = {};       // track which ability ids the player has unlocked this run
let equippedAbilityId = null;    // which ability spacebar currently activates
let abilityCooldownRemaining = 0; // ms remaining before the equipped ability can fire again

/* run statistics — tracked for pause overlay and death screen, does not affect gameplay */
const runStats = {
  killsByType: {}, // e.g. { ast_large: 4, drifter1: 9, hunter: 2, boss: 1, ... }
  totalKills: 0,
  shotsFired: 0,
  hitsTaken: 0,
  shieldBlocks: 0,
  upgradesChosen: 0
};

function trackKill(statKey, points){
  runStats.killsByType[statKey] = (runStats.killsByType[statKey]||0) + 1;
  runStats.totalKills++;
}

/* ============================================================
   ENTITY LISTS
============================================================ */
let asteroids = [];
let enemies = [];
let projectiles = [];
let particles = [];
let stars = [];
let pickupTexts = []; // floating score popups
let drones = []; // drone assist companions
let missiles = []; // ability projectiles (missile and any future ability ordnance)

/* ============================================================
   STARFIELD (parallax background)
============================================================ */
function initStars(){
  stars = [];
  const count = 220;
  for(let i=0;i<count;i++){
    stars.push({
      x: rand(-W, W*2),
      y: rand(-H, H*2),
      size: rand(0.5, 2.2),
      depth: rand(0.15, 0.6) // parallax factor
    });
  }
}

/* ============================================================
   ASTEROID FACTORY
============================================================ */
function makeAsteroidShape(points, irregularity){
  const shape = [];
  for(let i=0;i<points;i++){
    const a = (i/points) * Math.PI*2;
    const r = 1 - rand(0, irregularity);
    shape.push({a, r});
  }
  return shape;
}

function spawnAsteroid(forcedSize){
  // spawn at edge of an expanded radius around player, in world space
  const spawnDist = Math.max(W,H)*0.62;
  const ang = rand(0, Math.PI*2);
  const wx = worldShiftX + Math.cos(ang)*spawnDist;
  const wy = worldShiftY + Math.sin(ang)*spawnDist;

  const size = forcedSize || (Math.random() < 0.5 ? 'large' : (Math.random()<0.5 ? 'medium':'small'));
  const baseRadius = size === 'large' ? rand(46,62) : size === 'medium' ? rand(26,36) : rand(12,18);

  const driftAngle = angleTo(wx, wy, worldShiftX, worldShiftY) + rand(-0.35, 0.35);
  const driftSpeed = size === 'large' ? rand(0.9,1.5) : size === 'medium' ? rand(1.3,2.0) : rand(1.7,2.6);

  asteroids.push({
    x: wx, y: wy,
    vx: Math.cos(driftAngle)*driftSpeed,
    vy: Math.sin(driftAngle)*driftSpeed,
    radius: baseRadius,
    size,
    shape: makeAsteroidShape(randInt(8,12), 0.35),
    rotation: rand(0, Math.PI*2),
    rotSpeed: rand(-0.012, 0.012),
    hp: size === 'large' ? 3 : size === 'medium' ? 2 : 1,
    hitFlash: 0
  });
}

function splitAsteroid(a){
  if(a.size === 'large'){
    for(let i=0;i<2;i++){
      const ang = rand(0,Math.PI*2);
      asteroids.push({
        x: a.x, y: a.y,
        vx: Math.cos(ang)*rand(0.6,1.3) + a.vx*0.3,
        vy: Math.sin(ang)*rand(0.6,1.3) + a.vy*0.3,
        radius: rand(26,36),
        size: 'medium',
        shape: makeAsteroidShape(randInt(8,12), 0.35),
        rotation: rand(0,Math.PI*2),
        rotSpeed: rand(-0.02,0.02),
        hp: 2,
        hitFlash: 0
      });
    }
  } else if(a.size === 'medium'){
    for(let i=0;i<2;i++){
      const ang = rand(0,Math.PI*2);
      asteroids.push({
        x: a.x, y: a.y,
        vx: Math.cos(ang)*rand(0.9,1.8) + a.vx*0.3,
        vy: Math.sin(ang)*rand(0.9,1.8) + a.vy*0.3,
        radius: rand(12,18),
        size: 'small',
        shape: makeAsteroidShape(randInt(7,10), 0.4),
        rotation: rand(0,Math.PI*2),
        rotSpeed: rand(-0.03,0.03),
        hp: 1,
        hitFlash: 0
      });
    }
  }
}

/* ============================================================
   ENEMY FACTORY
   Types:
   - drifter: slow, drifts toward player, low hp, ramming damage
   - hunter: faster, actively steers toward player, shoots back
   - turret: stays at range, fires aimed bursts
   - boss: large, high hp, appears every few waves, multi-attack
============================================================ */
const MAX_ENEMIES = 60;

function spawnEnemy(type, forcedX, forcedY){
  if(enemies.length >= MAX_ENEMIES){
    // Boss-tier arrivals are rare, singular, and already announced by a banner —
    // never silently skip them. Instead, free up exactly one slot by removing
    // the single lowest-value enemy currently on screen, keeping the total
    // count at or under the cap rather than letting it grow past it.
    if(type === 'boss' || type === 'marksman'){
      let weakestIdx = -1, weakestScore = Infinity;
      for(let i=0;i<enemies.length;i++){
        if(enemies[i].scoreValue < weakestScore){
          weakestScore = enemies[i].scoreValue;
          weakestIdx = i;
        }
      }
      if(weakestIdx !== -1) enemies.splice(weakestIdx, 1);
    } else {
      return; // normal/swarm spawns simply don't happen once the cap is reached
    }
  }

  const spawnDist = Math.max(W,H)*0.65;
  const ang = rand(0, Math.PI*2);
  const wx = forcedX !== undefined ? forcedX : worldShiftX + Math.cos(ang)*spawnDist;
  const wy = forcedY !== undefined ? forcedY : worldShiftY + Math.sin(ang)*spawnDist;

  const base = {
    x: wx, y: wy,
    angle: 0,
    hitFlash: 0,
    lastFire: performance.now() + rand(0,800),
    spawnT: 0
  };

  if(type === 'drifter'){
    Object.assign(base, {
      type, tier: 1, radius: 13, hp: 2, maxHp: 2,
      speed: rand(1.4,1.9),
      color: 'magenta',
      scoreValue: 80
    });
  } else if(type === 'drifter2'){
    Object.assign(base, {
      type: 'drifter', tier: 2, radius: 13, hp: 2, maxHp: 2,
      speed: rand(2.1,2.6),
      color: 'drifter2',
      scoreValue: 95
    });
  } else if(type === 'drifter3'){
    Object.assign(base, {
      type: 'drifter', tier: 3, radius: 13, hp: 2, maxHp: 2,
      speed: rand(2.8,3.4),
      color: 'drifter3',
      scoreValue: 110
    });
  } else if(type === 'tank'){
    Object.assign(base, {
      type: 'tank', tier: 1, radius: 26, hp: 12, maxHp: 12,
      speed: rand(0.55,0.75),
      color: 'tank1',
      scoreValue: 220
    });
  } else if(type === 'tank2'){
    Object.assign(base, {
      type: 'tank', tier: 2, radius: 29, hp: 17, maxHp: 17,
      speed: rand(0.45,0.65),
      color: 'tank2',
      scoreValue: 260
    });
  } else if(type === 'tank3'){
    Object.assign(base, {
      type: 'tank', tier: 3, radius: 32, hp: 22, maxHp: 22,
      speed: rand(0.35,0.55),
      color: 'tank3',
      scoreValue: 300
    });
  } else if(type === 'hunter'){
    Object.assign(base, {
      type, radius: 11, hp: 3, maxHp: 3,
      speed: rand(2.0,2.6),
      fireRate: 1400,
      color: 'magenta',
      scoreValue: 140
    });
  } else if(type === 'turret'){
    Object.assign(base, {
      type, radius: 16, hp: 4, maxHp: 4,
      speed: 0.8,
      preferredRange: 320,
      fireRate: 1100,
      color: 'purple',
      scoreValue: 160
    });
  } else if(type === 'boss'){
    Object.assign(base, {
      type, radius: 42, hp: 40, maxHp: 40,
      speed: 1.1,
      fireRate: 650,
      color: 'amber',
      scoreValue: 1200,
      burstAngle: 0
    });
  } else if(type === 'marksman'){
    Object.assign(base, {
      type, radius: 36, hp: 30, maxHp: 30,
      speed: 0.5,
      preferredRange: 480,
      fireRate: 2600,        // time between full telegraph->beam cycles
      telegraphDuration: 1300, // how long the thin warning line shows before the beam fires
      laserState: 'idle',     // 'idle' | 'telegraph' | 'firing'
      laserTimer: 0,
      laserAngle: 0,
      color: 'green',
      scoreValue: 1400
    });
  }
  enemies.push(base);
}

/* ============================================================
   WAVE DIRECTOR
   Increases spawn rate & enemy mix over time / score.
============================================================ */
let spawnTimer = 0;
let bossSpawnedAtWave = 0;
let swarmActive = false;
let swarmTimeRemaining = 0;
let swarmSpawnTimer = 0;

function difficultyFactor(){
  // scales from 1.0 upward based on elapsed time and score
  return 1 + (elapsedTime/60)*0.55 + (score/4000)*0.4;
}

function updateWaveDirector(dt){
  // --- normal spawning always runs, swarm or not ---
  spawnTimer += dt;
  const diff = difficultyFactor();
  const baseInterval = Math.max(280, 1100 - diff*140); // ms between spawns, floors out

  if(spawnTimer > baseInterval){
    spawnTimer = 0;

    const asteroidChance = Math.max(0.35, 0.7 - diff*0.05);
    if(Math.random() < asteroidChance){
      spawnAsteroid();
    } else {
      const roll = Math.random();
      if(diff < 1.6){
        spawnEnemy('drifter');
      } else if(diff < 2.6){
        spawnEnemy(roll < 0.65 ? 'drifter' : 'hunter');
      } else if(diff < 3.4){
        if(roll < 0.45) spawnEnemy('drifter');
        else if(roll < 0.8) spawnEnemy('hunter');
        else spawnEnemy('turret');
      } else {
        // tanks join the rotation once things are already getting dangerous
        if(roll < 0.35) spawnEnemy('drifter');
        else if(roll < 0.6) spawnEnemy('hunter');
        else if(roll < 0.8) spawnEnemy('turret');
        else if(roll < 0.92) spawnEnemy('tank');
        else if(roll < 0.97) spawnEnemy('tank2');
        else spawnEnemy('tank3');
      }
    }
  }

  // --- drifter swarm event: piles extra drifters on top of normal spawning above ---
  if(swarmActive){
    swarmTimeRemaining -= dt;
    swarmSpawnTimer += dt;
    const swarmInterval = 130; // dense, exaggerated drifter volume during the swarm
    if(swarmSpawnTimer > swarmInterval){
      swarmSpawnTimer = 0;
      const roll = Math.random();
      const swarmType = roll < 0.34 ? 'drifter' : roll < 0.67 ? 'drifter2' : 'drifter3';
      spawnEnemy(swarmType);
    }
    if(swarmTimeRemaining <= 0){
      swarmActive = false;
    }
  }

  // every ~5000 score, randomly trigger one of: Captain boss, drifter swarm, or Marksman — once per threshold
  const bossWaveTarget = Math.floor(score/5000);
  if(bossWaveTarget > bossSpawnedAtWave && bossWaveTarget > 0){
    bossSpawnedAtWave = bossWaveTarget;
    const eventRoll = Math.random();
    if(eventRoll < 0.34){
      spawnEnemy('boss');
      flashWaveBanner('CAPTAIN INBOUND');
    } else if(eventRoll < 0.67){
      swarmActive = true;
      swarmTimeRemaining = 10000;
      swarmSpawnTimer = 0;
      flashWaveBanner('INCOMING WAVE OF DRIFTERS');
    } else {
      spawnEnemy('marksman');
      flashWaveBanner('MARKSMAN INBOUND');
    }
  }
}

let waveBannerTimeout = null;
function flashWaveBanner(text){
  const el = document.getElementById('wave-banner');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(waveBannerTimeout);
  waveBannerTimeout = setTimeout(()=> el.classList.remove('show'), 2200);
}

/* ============================================================
   PROJECTILES
============================================================ */
function fireWeapon(){
  const speedRatio = player.maxSpeed > 0 ? Math.min(1, player.speed / player.maxSpeed) : 0;
  const effectiveFireRate = weapon.fireRate * (1 - weapon.slipstreamBonus * speedRatio);

  const now = performance.now();
  if(now - weapon.lastFire < effectiveFireRate) return;
  weapon.lastFire = now;
  runStats.shotsFired++;

  const lanes = weapon.spread;
  const mid = (lanes-1)/2;
  for(let i=0;i<lanes;i++){
    const offset = (i - mid) * weapon.spreadAngle;
    const a = player.angle + offset;
    const isCrit = Math.random() < weapon.critChance;
    let shotDamage = isCrit ? weapon.damage * weapon.critMultiplier : weapon.damage;
    shotDamage *= (1 + weapon.momentumBonus * speedRatio);
    const driftPierce = weapon.driftPierceBonus > 0 && Math.random() < (weapon.driftPierceBonus * speedRatio);
    projectiles.push({
      x: worldShiftX, y: worldShiftY, // spawn at player world position
      vx: Math.cos(a)*weapon.speed,
      vy: Math.sin(a)*weapon.speed,
      life: 900,
      radius: weapon.projSize,
      piercing: weapon.piercing || driftPierce,
      explosive: weapon.explosive,
      damage: shotDamage,
      isCrit
    });
  }
  spawnMuzzleFlash();
}

function spawnMuzzleFlash(){
  particles.push({
    x: CX + Math.cos(player.angle)*22,
    y: CY + Math.sin(player.angle)*22,
    vx: Math.cos(player.angle)*1.5,
    vy: Math.sin(player.angle)*1.5,
    life: 120, maxLife: 120,
    size: 5, color: 'cyan', type: 'flash'
  });
}

function spawnExplosion(x, y, color, count, big){
  const n = count || 10;
  for(let i=0;i<n;i++){
    const a = rand(0,Math.PI*2);
    const sp = rand(big?2:0.8, big?6:3);
    particles.push({
      x, y,
      vx: Math.cos(a)*sp,
      vy: Math.sin(a)*sp,
      life: rand(280,520), maxLife: 500,
      size: rand(1.5, big?4:2.5),
      color: color || 'white',
      type: 'spark'
    });
  }
}

/* ============================================================
   DRONE ASSIST — self-contained passive support system.
   Drones orbit the player in screen space, scan for the nearest
   threat in world space, and fire their own small bullets at it.
   Kept fully separate from the main projectile list so the
   existing weapon/projectile collision logic is untouched.
============================================================ */
let droneBullets = [];

function spawnDrone(damage){
  const angleOffset = drones.length * (Math.PI*2/3); // spread multiple drones around the ship
  drones.push({
    orbitAngle: angleOffset,
    orbitRadius: 38,
    damage: damage,
    fireRate: 900,
    lastFire: 0,
    radius: 5
  });
}

function updateDrones(dt){
  if(drones.length === 0) return;

  // base fire rate scales slightly with the player's own rapid-fire upgrades
  const rapidScale = Math.max(0.5, 1 - weapon.rapidLevel*0.05);

  for(const d of drones){
    d.orbitAngle += 0.0016 * dt;
    const screenX = CX + Math.cos(d.orbitAngle)*d.orbitRadius;
    const screenY = CY + Math.sin(d.orbitAngle)*d.orbitRadius;
    const worldX = worldShiftX + Math.cos(d.orbitAngle)*d.orbitRadius;
    const worldY = worldShiftY + Math.sin(d.orbitAngle)*d.orbitRadius;

    // find nearest target within drone range (grid-limited to nearby cells first)
    const DRONE_RANGE = 260;
    let target = null, bestDist = DRONE_RANGE*DRONE_RANGE;
    const candidateEnemies = enemyGrid ? gridQuery(enemyGrid, worldX, worldY, DRONE_RANGE) : enemies;
    for(const e of candidateEnemies){
      const dd = dist2(worldX, worldY, e.x, e.y);
      if(dd < bestDist){ bestDist = dd; target = e; }
    }
    const candidateAsteroids = asteroidGrid ? gridQuery(asteroidGrid, worldX, worldY, DRONE_RANGE) : asteroids;
    for(const a of candidateAsteroids){
      const dd = dist2(worldX, worldY, a.x, a.y);
      if(dd < bestDist){ bestDist = dd; target = a; }
    }

    const now = performance.now();
    if(target && now - d.lastFire > d.fireRate*rapidScale){
      d.lastFire = now;
      const ang = angleTo(worldX, worldY, target.x, target.y);
      droneBullets.push({
        x: worldX, y: worldY,
        vx: Math.cos(ang)*7.5,
        vy: Math.sin(ang)*7.5,
        life: 700,
        radius: 2.5,
        damage: d.damage
      });
    }

    d._screenX = screenX;
    d._screenY = screenY;
  }

  // drone bullets travel and resolve against enemies/asteroids independently
  for(let i=droneBullets.length-1;i>=0;i--){
    const b = droneBullets[i];
    b.x += b.vx; b.y += b.vy;
    b.life -= dt;
    if(b.life <= 0){ droneBullets.splice(i,1); continue; }

    let hit = false;
    const nearbyEnemies = enemyGrid ? new Set(gridQuery(enemyGrid, b.x, b.y, b.radius + 40)) : null;
    for(let ei=enemies.length-1; ei>=0; ei--){
      const e = enemies[ei];
      if(nearbyEnemies && !nearbyEnemies.has(e)) continue;
      if(dist2(b.x,b.y,e.x,e.y) < (b.radius+e.radius)*(b.radius+e.radius)){
        e.hp -= b.damage;
        e.hitFlash = 100;
        const screenX = e.x - worldShiftX + CX;
        const screenY = e.y - worldShiftY + CY;
        if(e.hp <= 0){
          killEnemy(e, ei, screenX, screenY);
        }
        hit = true;
        break;
      }
    }
    if(!hit){
      const nearbyAsteroids = asteroidGrid ? new Set(gridQuery(asteroidGrid, b.x, b.y, b.radius + 65)) : null;
      for(let ai=asteroids.length-1; ai>=0; ai--){
        const a = asteroids[ai];
        if(nearbyAsteroids && !nearbyAsteroids.has(a)) continue;
        if(dist2(b.x,b.y,a.x,a.y) < (b.radius+a.radius)*(b.radius+a.radius)){
          a.hp -= b.damage;
          a.hitFlash = 100;
          const screenX = a.x - worldShiftX + CX;
          const screenY = a.y - worldShiftY + CY;
          if(a.hp <= 0){
            addScore(a.size === 'large' ? 60 : a.size === 'medium' ? 35 : 20);
            spawnExplosion(screenX, screenY, 'grey', 10, a.size==='large');
            trackKill(a.size==='large' ? 'ast_large' : a.size==='medium' ? 'ast_medium' : 'ast_small');
            const dax = a.x, day = a.y;
            splitAsteroid(a);
            asteroids.splice(ai,1);
            tryChainReaction(dax, day);
          }
          hit = true;
          break;
        }
      }
    }
    if(hit) droneBullets.splice(i,1);
  }
}

/* ============================================================
   MISSILE — the first entry in the ability system. Spacebar
   fires one in the direction the ship is facing once the
   cooldown is ready. It travels until it hits something or
   reaches its max range, then detonates: a real blast that
   damages and can kill everything in the radius (unlike the
   Fragment Warheads splash, which deals a flat 1 damage tick).
   Built as its own self-contained array/update/draw trio so
   future abilities can follow the same pattern independently.
============================================================ */
const MISSILE_CONFIG = {
  damage: 14,        // direct hit damage to whatever it first touches
  blastRadius: 90,
  blastDamage: 10,    // damage dealt to everything in the blast, including the direct-hit target
  speed: 6.5,
  maxRange: 900,
  cooldown: 5500
};

function fireMissile(){
  missiles.push({
    x: worldShiftX, y: worldShiftY,
    vx: Math.cos(player.angle)*MISSILE_CONFIG.speed,
    vy: Math.sin(player.angle)*MISSILE_CONFIG.speed,
    angle: player.angle,
    traveled: 0,
    radius: 6
  });
  runStats.shotsFired++;
}

function detonateMissile(wx, wy){
  const radius = MISSILE_CONFIG.blastRadius;

  const nearbyEnemies = enemyGrid ? new Set(gridQuery(enemyGrid, wx, wy, radius)) : null;
  for(let ei=enemies.length-1; ei>=0; ei--){
    const e = enemies[ei];
    if(nearbyEnemies && !nearbyEnemies.has(e)) continue;
    if(dist2(e.x,e.y,wx,wy) < radius*radius){
      e.hp -= MISSILE_CONFIG.blastDamage;
      e.hitFlash = 180;
      if(e.hp <= 0){
        const screenX = e.x - worldShiftX + CX;
        const screenY = e.y - worldShiftY + CY;
        killEnemy(e, ei, screenX, screenY);
      }
    }
  }
  const nearbyAsteroids = asteroidGrid ? new Set(gridQuery(asteroidGrid, wx, wy, radius)) : null;
  for(let ai=asteroids.length-1; ai>=0; ai--){
    const a = asteroids[ai];
    if(nearbyAsteroids && !nearbyAsteroids.has(a)) continue;
    if(dist2(a.x,a.y,wx,wy) < radius*radius){
      a.hp -= MISSILE_CONFIG.blastDamage;
      a.hitFlash = 180;
      if(a.hp <= 0){
        const screenX = a.x - worldShiftX + CX;
        const screenY = a.y - worldShiftY + CY;
        addScore(a.size === 'large' ? 60 : a.size === 'medium' ? 35 : 20);
        spawnExplosion(screenX, screenY, 'grey', 10, a.size==='large');
        trackKill(a.size==='large' ? 'ast_large' : a.size==='medium' ? 'ast_medium' : 'ast_small');
        splitAsteroid(a);
        asteroids.splice(ai,1);
      }
    }
  }

  const screenX = wx - worldShiftX + CX;
  const screenY = wy - worldShiftY + CY;
  spawnExplosion(screenX, screenY, 'amber', 26, true);
  tryChainReaction(wx, wy);
}

function updateMissiles(dt){
  for(let i=missiles.length-1;i>=0;i--){
    const m = missiles[i];
    m.x += m.vx; m.y += m.vy;
    m.traveled += MISSILE_CONFIG.speed;

    let hit = false;
    let hitX = m.x, hitY = m.y;

    const nearbyEnemySet = enemyGrid ? new Set(gridQuery(enemyGrid, m.x, m.y, m.radius + 40)) : null;
    for(let ei=enemies.length-1; ei>=0; ei--){
      const e = enemies[ei];
      if(nearbyEnemySet && !nearbyEnemySet.has(e)) continue;
      if(circleHit(m.x,m.y,m.radius, e.x,e.y,e.radius)){
        e.hp -= MISSILE_CONFIG.damage;
        e.hitFlash = 180;
        hitX = e.x; hitY = e.y;
        if(e.hp <= 0){
          const screenX = e.x - worldShiftX + CX;
          const screenY = e.y - worldShiftY + CY;
          killEnemy(e, ei, screenX, screenY);
        }
        hit = true;
        break;
      }
    }
    if(!hit){
      const nearbyAsteroidSet = asteroidGrid ? new Set(gridQuery(asteroidGrid, m.x, m.y, m.radius + 65)) : null;
      for(let ai=asteroids.length-1; ai>=0; ai--){
        const a = asteroids[ai];
        if(nearbyAsteroidSet && !nearbyAsteroidSet.has(a)) continue;
        if(circleHit(m.x,m.y,m.radius, a.x,a.y,a.radius)){
          hitX = a.x; hitY = a.y;
          hit = true;
          break;
        }
      }
    }

    if(hit || m.traveled >= MISSILE_CONFIG.maxRange){
      detonateMissile(hitX, hitY);
      missiles.splice(i,1);
    }
  }
}

function drawMissiles(){
  ctx.save();
  for(const m of missiles){
    const screenX = m.x - worldShiftX + CX;
    const screenY = m.y - worldShiftY + CY;
    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.rotate(m.angle);
    ctx.strokeStyle = '#ffb347';
    ctx.shadowColor = '#ffb347';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10,0);
    ctx.lineTo(-6,-4);
    ctx.lineTo(-3,0);
    ctx.lineTo(-6,4);
    ctx.closePath();
    ctx.stroke();
    // exhaust trail
    ctx.strokeStyle = 'rgba(255,179,71,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-3,0);
    ctx.lineTo(-14,0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawDrones(){
  ctx.save();
  for(const d of drones){
    if(d._screenX === undefined) continue;
    ctx.save();
    ctx.translate(d._screenX, d._screenY);
    ctx.strokeStyle = '#5fe3ff';
    ctx.shadowColor = '#5fe3ff';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0,0,d.radius,0,Math.PI*2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-d.radius-3,0); ctx.lineTo(-d.radius,0);
    ctx.moveTo(d.radius,0); ctx.lineTo(d.radius+3,0);
    ctx.stroke();
    ctx.restore();
  }
  for(const b of droneBullets){
    const screenX = b.x - worldShiftX + CX;
    const screenY = b.y - worldShiftY + CY;
    ctx.fillStyle = '#5fe3ff';
    ctx.shadowColor = '#5fe3ff';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(screenX, screenY, b.radius, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

/* ============================================================
   CHAIN REACTOR — on a kill, has a chance to trigger a bonus
   blast that damages nearby enemies/asteroids. Hooked in at
   existing kill points only; does not alter collision detection.
============================================================ */
function tryChainReaction(wx, wy){
  if(!weapon.chainReactor) return;
  if(Math.random() > weapon.chainChance) return;
  const radius = weapon.chainRadius || 70;

  const nearbyEnemies = enemyGrid ? new Set(gridQuery(enemyGrid, wx, wy, radius)) : null;
  for(let ei=enemies.length-1; ei>=0; ei--){
    const e = enemies[ei];
    if(nearbyEnemies && !nearbyEnemies.has(e)) continue;
    if(dist2(e.x,e.y,wx,wy) < radius*radius){
      e.hp -= 1;
      e.hitFlash = 150;
      if(e.hp <= 0){
        const screenX = e.x - worldShiftX + CX;
        const screenY = e.y - worldShiftY + CY;
        killEnemy(e, ei, screenX, screenY);
      }
    }
  }
  const nearbyAsteroids = asteroidGrid ? new Set(gridQuery(asteroidGrid, wx, wy, radius)) : null;
  for(let ai=asteroids.length-1; ai>=0; ai--){
    const a = asteroids[ai];
    if(nearbyAsteroids && !nearbyAsteroids.has(a)) continue;
    if(dist2(a.x,a.y,wx,wy) < radius*radius){
      a.hp -= 1;
      a.hitFlash = 150;
      if(a.hp <= 0){
        const screenX = a.x - worldShiftX + CX;
        const screenY = a.y - worldShiftY + CY;
        addScore(a.size === 'large' ? 60 : a.size === 'medium' ? 35 : 20);
        spawnExplosion(screenX, screenY, 'grey', 10, a.size==='large');
        trackKill(a.size==='large' ? 'ast_large' : a.size==='medium' ? 'ast_medium' : 'ast_small');
        splitAsteroid(a);
        asteroids.splice(ai,1);
      }
    }
  }
  const screenX = wx - worldShiftX + CX;
  const screenY = wy - worldShiftY + CY;
  spawnExplosion(screenX, screenY, 'green', 14, true);
}

/* ============================================================
   INPUT
============================================================ */
window.addEventListener('keydown', (e)=>{
  const wasDown = keys[e.code];
  keys[e.code] = true;
  if(e.code === 'Space'){
    e.preventDefault();
    if(!wasDown && gameState === STATE.PLAYING){
      activateAbility(); // edge-triggered: one activation per press, ignores key-repeat while held
    }
  }
  if(e.code === 'Escape' && gameState === STATE.PLAYING){
    togglePause();
  } else if(e.code === 'Escape' && gameState === STATE.PAUSED){
    togglePause();
  }
});
window.addEventListener('keyup', (e)=>{
  keys[e.code] = false;
});
mainCanvas.addEventListener('mousemove', (e)=>{
  const rect = mainCanvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});
mainCanvas.addEventListener('mousedown', (e)=>{ if(e.button===0) mouseDown = true; });
window.addEventListener('mouseup', (e)=>{ if(e.button===0) mouseDown = false; });
mainCanvas.style.pointerEvents = 'all';

function togglePause(){
  if(gameState === STATE.PLAYING){
    gameState = STATE.PAUSED;
    document.getElementById('pause-hint').classList.add('hidden');
    renderPauseStats();
    renderKillLog('pause-kill-log', 'pause-kill-total');
    document.getElementById('pause-screen').classList.remove('hidden');
  } else if(gameState === STATE.PAUSED){
    gameState = STATE.PLAYING;
    document.getElementById('pause-screen').classList.add('hidden');
    document.getElementById('pause-hint').classList.remove('hidden');
  }
}

/* ============================================================
   SHARED STAT / KILL-LOG RENDERING — used by both the pause
   overlay and the death screen so they stay consistent.
============================================================ */
function formatTime(totalSeconds){
  const mins = Math.floor(totalSeconds/60);
  const secs = Math.floor(totalSeconds%60).toString().padStart(2,'0');
  return `${mins}:${secs}`;
}

function buildShipStatRows(){
  const accuracy = runStats.shotsFired > 0
    ? Math.round((runStats.totalKills / runStats.shotsFired) * 100)
    : 0;
  return [
    ['Score', Math.floor(score).toString(), true],
    ['Time survived', formatTime(elapsedTime), false],
    ['Lives', `${player.lives} / ${player.maxLives}`, false],
    ['Shield charges', `${player.shieldCharge} / ${player.shieldMax}`, false],
    ['Weapon damage', weapon.damage.toFixed(2)+'x', false],
    ['Fire rate', Math.round(weapon.fireRate)+' ms', false],
    ['Bullet spread', `${weapon.spread} lane${weapon.spread>1?'s':''}`, false],
    ['Bullet speed', weapon.speed.toFixed(1), false],
    ['Move speed cap', player.maxSpeed.toFixed(1), false],
    ['Piercing', weapon.piercing ? `yes (${Math.round(weapon.pierceDamageRetain*100)}% retain)` : 'no', false],
    ['Explosive rounds', weapon.explosive ? `yes (r=${Math.round(weapon.explosiveRadius)})` : 'no', false],
    ['Chain reactor', weapon.chainReactor ? `yes (${Math.round(weapon.chainChance*100)}% chance)` : 'no', false],
    ['Drones deployed', drones.length.toString(), false],
    ['Crit chance', weapon.critChance > 0 ? `${(weapon.critChance*100).toFixed(1)}% (${weapon.critMultiplier.toFixed(2)}x)` : 'none', false],
    ['Hull Breaker bonus', weapon.hullBreakerBonus > 0 ? `+${Math.round(weapon.hullBreakerBonus*100)}%` : 'none', false],
    ['Slipstream', weapon.slipstreamBonus > 0 ? `+${Math.round(weapon.slipstreamBonus*100)}% fire rate @ top speed` : 'none', false],
    ['Momentum Strikes', weapon.momentumBonus > 0 ? `+${Math.round(weapon.momentumBonus*100)}% dmg @ top speed` : 'none', false],
    ['Evasive Plating', player.evasivePlatingBonus > 0 ? `+${Math.round(player.evasivePlatingBonus*100)}% dodge @ top speed` : 'none', false],
    ['Afterburn', player.afterburnDamage > 0 ? `${player.afterburnDamage.toFixed(1)} dmg/tick (r=${Math.round(player.afterburnRadius)})` : 'none', false],
    ['Overcharged Drift', weapon.driftPierceBonus > 0 ? `+${Math.round(weapon.driftPierceBonus*100)}% pierce @ top speed` : 'none', false],
    ['Score bonus', player.scoreBonusPct > 0 ? `+${player.scoreBonusPct}%` : 'none', false],
    ['Spare Parts', player.sparePartsChance > 0 ? `${Math.round(player.sparePartsChance*100)}%` : 'none', false],
    ['Invuln window', `${player.invulnDuration}ms`, false],
    ['Shots fired', runStats.shotsFired.toString(), false],
    ['Accuracy', `${accuracy}%`, false],
    ['Hits taken', runStats.hitsTaken.toString(), false],
    ['Shield blocks', runStats.shieldBlocks.toString(), false],
    ['Upgrades chosen', runStats.upgradesChosen.toString(), false],
  ];
}

function renderStatGrid(containerId, rows){
  const el = document.getElementById(containerId);
  el.innerHTML = rows.map(([label, value, accent]) => `
    <div class="stat-label">${label}</div>
    <div class="stat-value${accent ? ' accent' : ''}">${value}</div>
  `).join('');
}

function renderPauseStats(){
  renderStatGrid('pause-stats-left', buildShipStatRows());
}

// build a lookup of enemy id -> display name from the existing Enemy Guide data,
// so the kill log always matches the names already shown to the player
function enemyDisplayName(statKey){
  const entry = ENEMY_GUIDE.find(e => e.id === statKey);
  return entry ? entry.name : statKey;
}

function renderKillLog(logContainerId, totalContainerId){
  const logEl = document.getElementById(logContainerId);
  const totalEl = document.getElementById(totalContainerId);
  const entries = Object.entries(runStats.killsByType).sort((a,b) => b[1]-a[1]);

  if(entries.length === 0){
    logEl.innerHTML = `<div class="kill-log-empty">NO KILLS YET</div>`;
  } else {
    logEl.innerHTML = entries.map(([key, count]) => `
      <div class="kill-log-row">
        <span class="klname">${enemyDisplayName(key)}</span>
        <span class="klcount">&times;${count}</span>
      </div>
    `).join('');
  }
  totalEl.innerHTML = `<span>TOTAL KILLS</span><span class="total-num">${runStats.totalKills}</span>`;
}

/* ============================================================
   UPGRADE DEFINITIONS — two-layer probability system
   Layer 1: which upgrade TYPE (weighted by rarity tier)
   Layer 2: which STRENGTH TIER for that upgrade (independent roll)
============================================================ */

// strength tier definitions: multiplier scales the upgrade's base effect,
// weight is the probability of rolling that tier on layer 2
const TIER_DEFS = {
  low:       { label: 'LOW',       multiplier: 1.0, weight: 50, cssClass: 'tier-low' },
  medium:    { label: 'MEDIUM',    multiplier: 1.6, weight: 30, cssClass: 'tier-medium' },
  high:      { label: 'HIGH',      multiplier: 2.4, weight: 15, cssClass: 'tier-high' },
  legendary: { label: 'LEGENDARY', multiplier: 3.5, weight: 5,  cssClass: 'tier-legendary' }
};
const TIER_ORDER = ['low','medium','high','legendary'];

function rollTier(){
  const totalWeight = TIER_ORDER.reduce((s,k)=>s+TIER_DEFS[k].weight, 0);
  let roll = Math.random() * totalWeight;
  for(const key of TIER_ORDER){
    roll -= TIER_DEFS[key].weight;
    if(roll <= 0) return key;
  }
  return 'low';
}

/* ============================================================
   CARD TYPE SYSTEM — three kinds of card, all drawn from the
   same UPGRADE_POOL/JOKER_POOL/ABILITY_POOL arrays:

   - 'family'    : specialized, build-defining cards. Each has a
                   `family` key (e.g. 'damage', 'drones') so the
                   picker can eventually weight by family instead
                   of treating every card as independent — that
                   weighting logic isn't built yet, this is just
                   the tagging groundwork for it.
   - 'nonfamily' : simple, universal stat cards. No `family` key.
   - 'joker'     : rare risk/reward trade-off cards. Lives in its
                   own JOKER_POOL array, empty for now — nothing
                   has been designed for it yet.

   FAMILY_DEFS is the single source of truth for family display
   info (label, color) so new families only need one entry here
   rather than scattered string literals elsewhere.
============================================================ */
const FAMILY_DEFS = {
  damage: { label: 'DAMAGE', color: 'magenta' },
  drones: { label: 'DRONES', color: 'cyan' },
  mobility: { label: 'MOBILITY', color: 'amber' },
};

// Joker cards: rare, high-impact trade-off cards (gain something, give up
// something). Intentionally empty until the actual cards are designed.
const JOKER_POOL = [];

// rarity weight per upgrade type (layer 1) — common ~60% (5 items), uncommon ~25% (4 items), rare ~15% (2 items)
const UPGRADE_POOL = [
  // ---- COMMON (5 commons sum to ~60: rapid, speed, projspeed, damage, armor) ----
  {
    id: 'rapid',
    name: 'OVERCLOCKED FEED',
    tag: 'OFFENSE',
    rarity: 'COMMON',
    cardType: 'nonfamily',
    weight: 5,
    iconColor: 'amber',
    descBase: 'Reduce weapon cooldown. The cannon cycles faster.',
    available(){ return weapon.rapidLevel < 8; },
    // base effect at "low" tier: -12% cooldown; scaled by tier multiplier
    getEffect(tier){
      const pct = Math.round(12 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% fire rate`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.rapidLevel++;
      weapon.fireRate = Math.max(60, weapon.fireRate * (1 - pct/100));
    }
  },
  {
    id: 'speed',
    name: 'THRUSTER BOOST',
    tag: 'MOBILITY',
    rarity: 'COMMON',
    cardType: 'nonfamily',
    weight: 5,
    iconColor: 'cyan',
    descBase: 'Increase maximum drift speed and acceleration.',
    available(){ return weapon.speedLevel < 8; },
    getEffect(tier){
      const pct = Math.round(15 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% move speed`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.speedLevel++;
      player.maxSpeed *= (1 + pct/100);
      player.accel *= (1 + pct/200);
    }
  },
  {
    id: 'projspeed',
    name: 'VELOCITY COILS',
    tag: 'OFFENSE',
    rarity: 'COMMON',
    cardType: 'family',
    family: 'damage',
    weight: 5,
    iconColor: 'amber',
    descBase: 'Projectiles travel faster and reach targets sooner.',
    available(){ return weapon.speed < 30; },
    getEffect(tier){
      const pct = Math.round(15 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% bullet speed`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.speed *= (1 + pct/100);
    }
  },
  {
    id: 'damage',
    name: 'WARHEAD YIELD',
    tag: 'OFFENSE',
    rarity: 'COMMON',
    cardType: 'nonfamily',
    weight: 5,
    iconColor: 'magenta',
    descBase: 'Increase the base damage dealt by every projectile.',
    available(){ return true; },
    getEffect(tier){
      const pct = Math.round(20 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% damage`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.damage *= (1 + pct/100);
    }
  },

  // ---- UNCOMMON (4 upgrades sum to ~25) ----
  {
    id: 'piercing',
    name: 'PHASE ROUNDS',
    tag: 'OFFENSE',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'damage',
    weight: 2.5,
    iconColor: 'purple',
    descBase: 'Projectiles pass through targets instead of stopping.',
    available(){ return true; },
    getEffect(tier){
      const pct = Math.round(10 * TIER_DEFS[tier].multiplier);
      const newRetain = Math.round(Math.min(0.95, (weapon.pierceDamageRetain||0.7) + pct/200) * 100);
      const text = weapon.piercing
        ? `+${pct}% damage retained per pierce (now ${newRetain}%)`
        : `Pierce targets, keeping ${newRetain}% damage per hit`;
      return { text, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.piercing = true;
      weapon.pierceDamageRetain = Math.min(0.95, (weapon.pierceDamageRetain||0.7) + pct/200);
    }
  },
  {
    id: 'explosive',
    name: 'FRAGMENT WARHEADS',
    tag: 'OFFENSE',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'damage',
    weight: 2.5,
    iconColor: 'magenta',
    descBase: 'Projectiles detonate on impact, damaging nearby targets.',
    available(){ return true; },
    getEffect(tier){
      const radiusAdd = Math.round(10 * TIER_DEFS[tier].multiplier);
      return { text: `+${radiusAdd} blast radius`, radiusAdd };
    },
    apply(tier){
      const { radiusAdd } = this.getEffect(tier);
      weapon.explosive = true;
      weapon.explosiveRadius += radiusAdd;
    }
  },
  {
    id: 'chain_reactor',
    name: 'CHAIN REACTOR',
    tag: 'OFFENSE',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'damage',
    weight: 2.5,
    iconColor: 'green',
    descBase: 'Kills have a chance to chain into a damaging blast on nearby enemies.',
    available(){ return true; },
    getEffect(tier){
      const pct = Math.round(20 * TIER_DEFS[tier].multiplier);
      return { text: `+${Math.min(pct,95)}% chain chance`, pct: Math.min(pct,95) };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.chainReactor = true;
      weapon.chainChance = Math.min(0.95, (weapon.chainChance||0) + pct/100);
      weapon.chainRadius = Math.max(weapon.chainRadius||0, 70);
    }
  },
  {
    id: 'hull_breaker',
    name: 'HULL BREAKER',
    tag: 'OFFENSE',
    rarity: 'COMMON',
    cardType: 'family',
    family: 'damage',
    weight: 5,
    iconColor: 'magenta',
    descBase: 'Your shots hit harder against heavily armored targets — Tanks, the Captain, and the Marksman.',
    available(){ return weapon.hullBreakerBonus < 2.0; },
    getEffect(tier){
      const pct = Math.round(15 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% damage vs. Tanks &amp; bosses`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.hullBreakerBonus = Math.min(2.0, weapon.hullBreakerBonus + pct/100);
    }
  },
  {
    id: 'crit_damage_boost',
    name: 'OVERCHARGED CRIT',
    tag: 'OFFENSE',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'damage',
    weight: 2.5,
    iconColor: 'amber',
    descBase: 'Increases the damage multiplier on critical hits. Requires Critical Strike.',
    available(){ return weapon.critChance > 0 && weapon.critMultiplier < 5; },
    getEffect(tier){
      const add = +(0.3 * TIER_DEFS[tier].multiplier).toFixed(2);
      return { text: `+${add}x crit multiplier (now ${(weapon.critMultiplier+add).toFixed(2)}x)`, add };
    },
    apply(tier){
      const { add } = this.getEffect(tier);
      weapon.critMultiplier = Math.min(5, weapon.critMultiplier + add);
    }
  },
  {
    id: 'slipstream',
    name: 'SLIPSTREAM',
    tag: 'MOBILITY',
    rarity: 'COMMON',
    cardType: 'family',
    family: 'mobility',
    weight: 5,
    iconColor: 'amber',
    descBase: 'The faster you move, the faster your cannon cycles. Fire rate scales with your current speed.',
    available(){ return weapon.slipstreamBonus < 0.7; },
    getEffect(tier){
      const pct = Math.round(12 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% fire rate at top speed`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.slipstreamBonus = Math.min(0.7, weapon.slipstreamBonus + pct/100);
    }
  },
  {
    id: 'momentum_strikes',
    name: 'MOMENTUM STRIKES',
    tag: 'MOBILITY',
    rarity: 'COMMON',
    cardType: 'family',
    family: 'mobility',
    weight: 5,
    iconColor: 'amber',
    descBase: 'Your shots hit harder the faster you are moving when you fire them.',
    available(){ return weapon.momentumBonus < 1.0; },
    getEffect(tier){
      const pct = Math.round(15 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% damage at top speed`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.momentumBonus = Math.min(1.0, weapon.momentumBonus + pct/100);
    }
  },
  {
    id: 'evasive_plating',
    name: 'EVASIVE PLATING',
    tag: 'MOBILITY',
    rarity: 'COMMON',
    cardType: 'family',
    family: 'mobility',
    weight: 5,
    iconColor: 'cyan',
    descBase: 'The faster you are moving when you get hit, the better your odds of taking no damage at all.',
    available(){ return player.evasivePlatingBonus < 0.7; },
    getEffect(tier){
      const pct = Math.round(12 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% dodge chance at top speed`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      player.evasivePlatingBonus = Math.min(0.7, player.evasivePlatingBonus + pct/100);
    }
  },
  {
    id: 'afterburn',
    name: 'AFTERBURN',
    tag: 'MOBILITY',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'mobility',
    weight: 2.5,
    iconColor: 'magenta',
    descBase: 'While moving fast, anything you fly close to takes ongoing damage from your slipstream.',
    available(){ return player.afterburnDamage < 6; },
    getEffect(tier){
      const dmg = +(0.6 * TIER_DEFS[tier].multiplier).toFixed(1);
      const radius = Math.round(50 * TIER_DEFS[tier].multiplier);
      return { text: `${dmg} dmg/tick in r=${radius} at top speed`, dmg, radius };
    },
    apply(tier){
      const { dmg, radius } = this.getEffect(tier);
      player.afterburnDamage += dmg;
      player.afterburnRadius = Math.max(player.afterburnRadius, radius);
    }
  },
  {
    id: 'overcharged_drift',
    name: 'OVERCHARGED DRIFT',
    tag: 'MOBILITY',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'mobility',
    weight: 2.5,
    iconColor: 'purple',
    descBase: 'Moving at speed charges your shots with enough force to punch through a target.',
    available(){ return weapon.driftPierceBonus < 1.0; },
    getEffect(tier){
      const pct = Math.round(15 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% pierce chance at top speed`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.driftPierceBonus = Math.min(1.0, weapon.driftPierceBonus + pct/100);
    }
  },
  {
    id: 'drone_assist',
    name: 'DRONE ASSIST',
    tag: 'SUPPORT',
    rarity: 'UNCOMMON',
    cardType: 'family',
    family: 'drones',
    weight: 2.5,
    iconColor: 'cyan',
    descBase: 'A small drone follows you and fires on nearby enemies.',
    available(){ return drones.length < 3; },
    getEffect(tier){
      const dmg = Math.round(1 * TIER_DEFS[tier].multiplier);
      return { text: drones.length===0 ? `Deploys 1 drone (${dmg} dmg/shot)` : `+1 drone (${dmg} dmg/shot)`, dmg };
    },
    apply(tier){
      const { dmg } = this.getEffect(tier);
      spawnDrone(dmg);
    }
  },

  // ---- MODIFICATIONS (non-family, but uncommon-ish — these change how the
  // ship fires rather than how strong it is, so they're kept less frequent
  // than basic stats without being locked away as fully Rare) ----
  {
    id: 'spread',
    name: 'TRI-SPREAD ARRAY',
    tag: 'MODIFICATION',
    rarity: 'UNCOMMON',
    cardType: 'nonfamily',
    weight: 2.5,
    iconColor: 'amber',
    descBase: 'Fire an additional lane of projectiles in a wider spread.',
    available(){ return weapon.spread < 6; },
    getEffect(tier){
      const lanes = tier === 'legendary' ? 2 : 1;
      return { text: `+${lanes} bullet lane${lanes>1?'s':''}`, lanes };
    },
    apply(tier){
      const { lanes } = this.getEffect(tier);
      weapon.spread = Math.min(6, weapon.spread + lanes);
    }
  },
  {
    id: 'extra_life',
    name: 'HULL CAPACITY',
    tag: 'SURVIVAL',
    rarity: 'RARE',
    cardType: 'nonfamily',
    weight: 15,
    iconColor: 'green',
    descBase: 'Repair the hull and raise your maximum life capacity.',
    available(){ return player.maxLives < 8; },
    getEffect(tier){
      const lives = tier === 'legendary' ? 2 : 1;
      const shieldBonus = tier === 'high' ? 1 : tier === 'legendary' ? 1 : 0;
      const text = shieldBonus > 0
        ? `+${lives} max life, +${shieldBonus} shield charge`
        : `+${lives} max life`;
      return { text, lives, shieldBonus };
    },
    apply(tier){
      const { lives, shieldBonus } = this.getEffect(tier);
      player.maxLives = Math.min(8, player.maxLives + lives);
      player.lives = Math.min(player.maxLives, player.lives + lives);
      if(shieldBonus > 0){
        player.shieldMax += shieldBonus;
        player.shieldCharge = player.shieldMax;
      }
    }
  },
  {
    id: 'crit_strike',
    name: 'CRITICAL STRIKE',
    tag: 'OFFENSE',
    rarity: 'UNCOMMON',
    cardType: 'nonfamily',
    weight: 2.5,
    iconColor: 'amber',
    descBase: `A small chance for any shot to land as a critical hit for ${weapon.critMultiplier}x damage.`,
    available(){ return weapon.critChance < 0.5; },
    getEffect(tier){
      const pct = +(5 * TIER_DEFS[tier].multiplier).toFixed(1);
      return { text: `+${pct}% crit chance (${weapon.critMultiplier}x dmg)`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      weapon.critChance = Math.min(0.5, weapon.critChance + pct/100);
    }
  },
  {
    id: 'extended_recovery',
    name: 'EXTENDED RECOVERY',
    tag: 'SURVIVAL',
    rarity: 'COMMON',
    cardType: 'nonfamily',
    weight: 5,
    iconColor: 'cyan',
    descBase: 'Lengthens the brief invulnerability window granted right after taking a hit.',
    available(){ return player.invulnDuration < 2500; },
    getEffect(tier){
      const addMs = Math.round(150 * TIER_DEFS[tier].multiplier);
      return { text: `+${addMs}ms invulnerability`, addMs };
    },
    apply(tier){
      const { addMs } = this.getEffect(tier);
      player.invulnDuration = Math.min(2500, player.invulnDuration + addMs);
    }
  },
  {
    id: 'scrap_collector',
    name: 'SCRAP COLLECTOR',
    tag: 'ECONOMY',
    rarity: 'COMMON',
    cardType: 'nonfamily',
    weight: 5,
    iconColor: 'green',
    descBase: 'Salvage extra value from every kill. Increases all score gained.',
    available(){ return player.scoreBonusPct < 100; },
    getEffect(tier){
      const pct = Math.round(8 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% score from kills`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      player.scoreBonusPct = Math.min(100, player.scoreBonusPct + pct);
    }
  },
  {
    id: 'spare_parts',
    name: 'SPARE PARTS',
    tag: 'SURVIVAL',
    rarity: 'UNCOMMON',
    cardType: 'nonfamily',
    weight: 2.5,
    iconColor: 'green',
    descBase: 'A chance that a hit which gets past your shield costs no life at all.',
    available(){ return player.sparePartsChance < 0.5; },
    getEffect(tier){
      const pct = Math.round(8 * TIER_DEFS[tier].multiplier);
      return { text: `+${pct}% chance to no-sell a hit`, pct };
    },
    apply(tier){
      const { pct } = this.getEffect(tier);
      player.sparePartsChance = Math.min(0.5, player.sparePartsChance + pct/100);
    }
  },
  {
    id: 'overdraw',
    name: 'OVERDRAW',
    tag: 'OFFENSE',
    rarity: 'COMMON',
    cardType: 'nonfamily',
    weight: 5,
    iconColor: 'amber',
    descBase: "Widens your projectiles' hit radius, making it easier to land shots.",
    available(){ return weapon.projSize < 8; },
    getEffect(tier){
      const add = tier === 'legendary' ? 2 : 1;
      return { text: `+${add} projectile size`, add };
    },
    apply(tier){
      const { add } = this.getEffect(tier);
      weapon.projSize = Math.min(8, weapon.projSize + add);
    }
  },
];

// Deflector Armor — placed in the COMMON tier per design decision (not explicitly
// listed in the original rarity spec, assigned to the common bucket on clarification)
const ARMOR_UPGRADE = {
  id: 'armor',
  name: 'DEFLECTOR ARMOR',
  tag: 'SURVIVAL',
  rarity: 'COMMON',
  cardType: 'nonfamily',
  weight: 5,
  iconColor: 'cyan',
  descBase: 'Charge a shield that absorbs hits before hull damage is taken.',
  available(){ return true; },
  getEffect(tier){
    const charges = tier === 'legendary' ? 3 : tier === 'high' ? 2 : 1;
    return { text: `+${charges} shield charge${charges>1?'s':''}`, charges };
  },
  apply(tier){
    const { charges } = this.getEffect(tier);
    player.shieldMax += charges;
    player.shieldCharge = player.shieldMax;
  }
};
UPGRADE_POOL.push(ARMOR_UPGRADE);

/* ============================================================
   ABILITY POOL — a separate category from stat/mod upgrades.
   Drawn into the same 3-card offer alongside UPGRADE_POOL, but
   abilities don't roll a strength tier; picking one is a single
   permanent unlock. Each entry's available() generically checks
   ownedAbilities so this scales to future abilities without any
   changes to the picker, the card renderer, or the input layer —
   only equip()/activate() ever need to be written per-ability.
============================================================ */
const ABILITY_POOL = [
  {
    id: 'missile',
    name: 'MISSILE',
    tag: 'ABILITY',
    category: 'ability',
    rarity: 'UNCOMMON',
    weight: 9,
    iconColor: 'amber',
    descBase: 'Bind a missile launcher to SPACE. Fires toward your cursor, dealing heavy damage and detonating in a wide blast that can destroy anything caught in it.',
    cooldownMs: MISSILE_CONFIG.cooldown,
    available(){ return !ownedAbilities['missile']; },
    getEffect(){
      const cd = (MISSILE_CONFIG.cooldown/1000).toFixed(1);
      return { text: `${MISSILE_CONFIG.damage} dmg direct &middot; ${MISSILE_CONFIG.blastDamage} dmg blast (r=${MISSILE_CONFIG.blastRadius}) &middot; ${cd}s cooldown` };
    },
    apply(){
      ownedAbilities['missile'] = true;
      equippedAbilityId = 'missile';
      abilityCooldownRemaining = 0; // ready to use immediately on pickup
    },
    activate(){
      fireMissile();
    }
  },
];

function getEquippedAbility(){
  if(!equippedAbilityId) return null;
  return ABILITY_POOL.find(a => a.id === equippedAbilityId) || null;
}

function activateAbility(){
  const ability = getEquippedAbility();
  if(!ability) return; // no ability owned yet — space does nothing
  if(abilityCooldownRemaining > 0) return;
  ability.activate();
  abilityCooldownRemaining = ability.cooldownMs;
}

function weightedPickDistinct(pool, count){
  const available = pool.filter(u => u.available());
  const chosen = [];
  const copy = available.slice();
  while(chosen.length < count && copy.length > 0){
    const totalWeight = copy.reduce((s,u)=>s+u.weight, 0);
    let roll = Math.random() * totalWeight;
    let pickedIdx = 0;
    for(let i=0;i<copy.length;i++){
      roll -= copy[i].weight;
      if(roll <= 0){ pickedIdx = i; break; }
    }
    chosen.push(copy.splice(pickedIdx,1)[0]);
  }
  return chosen;
}

function pickUpgradeOptions(){
  const combinedPool = [...UPGRADE_POOL, ...ABILITY_POOL, ...JOKER_POOL];
  const typesChosen = weightedPickDistinct(combinedPool, 3);
  // stat/mod cards independently roll a strength tier (layer 2);
  // ability cards and joker cards have no tier
  return typesChosen.map(upgrade => ({
    upgrade,
    tier: (upgrade.category === 'ability' || upgrade.cardType === 'joker') ? null : rollTier()
  }));
}

function drawUpgradeIcon(svgHost, color, id){
  // build a tiny inline SVG icon per upgrade type, wireframe style
  const colorMap = {
    green: 'var(--green)', cyan: 'var(--cyan)', amber: 'var(--amber)',
    magenta: 'var(--magenta)', purple: 'var(--purple)'
  };
  const c = colorMap[color] || 'var(--cyan)';
  let inner = '';
  switch(id){
    case 'extra_life':
      inner = `<path d="M32 50 C10 36 6 20 18 14 C26 10 32 16 32 16 C32 16 38 10 46 14 C58 20 54 36 32 50 Z" fill="none" stroke="${c}" stroke-width="2.5"/>`;
      break;
    case 'armor':
      inner = `<path d="M32 8 L54 16 V32 C54 46 44 54 32 58 C20 54 10 46 10 32 V16 Z" fill="none" stroke="${c}" stroke-width="2.5"/>`;
      break;
    case 'spread':
      inner = `<line x1="14" y1="50" x2="32" y2="12" stroke="${c}" stroke-width="2.5"/><line x1="32" y1="54" x2="32" y2="10" stroke="${c}" stroke-width="2.5"/><line x1="50" y1="50" x2="32" y2="12" stroke="${c}" stroke-width="2.5"/>`;
      break;
    case 'rapid':
      inner = `<polyline points="14,40 28,40 22,52 50,28 36,28 42,16" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/>`;
      break;
    case 'explosive':
      inner = `<circle cx="32" cy="32" r="6" fill="${c}"/><line x1="32" y1="32" x2="32" y2="10" stroke="${c}" stroke-width="2"/><line x1="32" y1="32" x2="50" y2="20" stroke="${c}" stroke-width="2"/><line x1="32" y1="32" x2="50" y2="44" stroke="${c}" stroke-width="2"/><line x1="32" y1="32" x2="14" y2="44" stroke="${c}" stroke-width="2"/><line x1="32" y1="32" x2="14" y2="20" stroke="${c}" stroke-width="2"/>`;
      break;
    case 'piercing':
      inner = `<line x1="10" y1="32" x2="54" y2="32" stroke="${c}" stroke-width="2.5"/><circle cx="22" cy="32" r="4" fill="none" stroke="${c}" stroke-width="2"/><circle cx="42" cy="32" r="4" fill="none" stroke="${c}" stroke-width="2"/>`;
      break;
    case 'speed':
      inner = `<polygon points="14,32 40,18 34,32 40,46" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/><line x1="40" y1="32" x2="54" y2="32" stroke="${c}" stroke-width="2"/>`;
      break;
    case 'projspeed':
      inner = `<line x1="10" y1="32" x2="44" y2="32" stroke="${c}" stroke-width="2.5"/><polygon points="44,24 56,32 44,40" fill="${c}"/>`;
      break;
    case 'damage':
      inner = `<polygon points="32,8 40,26 58,28 44,40 48,58 32,48 16,58 20,40 6,28 24,26" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`;
      break;
    case 'chain_reactor':
      inner = `<circle cx="18" cy="46" r="6" fill="none" stroke="${c}" stroke-width="2.2"/><circle cx="34" cy="24" r="6" fill="none" stroke="${c}" stroke-width="2.2"/><circle cx="50" cy="42" r="6" fill="none" stroke="${c}" stroke-width="2.2"/><line x1="22" y1="42" x2="30" y2="28" stroke="${c}" stroke-width="1.8"/><line x1="38" y1="27" x2="46" y2="38" stroke="${c}" stroke-width="1.8"/>`;
      break;
    case 'drone_assist':
      inner = `<circle cx="32" cy="20" r="7" fill="none" stroke="${c}" stroke-width="2.2"/><line x1="32" y1="27" x2="32" y2="38" stroke="${c}" stroke-width="2"/><polygon points="18,52 32,38 46,52 32,46" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`;
      break;
    case 'missile':
      inner = `<polygon points="50,32 18,18 24,32 18,46" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/><line x1="10" y1="32" x2="20" y2="32" stroke="${c}" stroke-width="2"/>`;
      break;
    case 'crit_strike':
      inner = `<polygon points="32,6 38,24 56,24 41,35 47,53 32,42 17,53 23,35 8,24 26,24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="32" cy="32" r="4" fill="${c}"/>`;
      break;
    case 'extended_recovery':
      inner = `<circle cx="32" cy="32" r="20" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M32 32 L32 18" stroke="${c}" stroke-width="2.2"/><path d="M32 32 L44 38" stroke="${c}" stroke-width="2.2"/><path d="M48 14 A24 24 0 0 1 54 32" fill="none" stroke="${c}" stroke-width="2.2" stroke-dasharray="3,3"/>`;
      break;
    case 'scrap_collector':
      inner = `<polygon points="32,8 50,18 50,46 32,56 14,46 14,18" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><text x="32" y="38" font-size="18" fill="${c}" text-anchor="middle" font-family="monospace">$</text>`;
      break;
    case 'spare_parts':
      inner = `<circle cx="32" cy="32" r="18" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M22 32 L28 38 L42 24" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'overdraw':
      inner = `<circle cx="32" cy="32" r="6" fill="none" stroke="${c}" stroke-width="2.2"/><line x1="32" y1="6" x2="32" y2="18" stroke="${c}" stroke-width="2.2"/><line x1="32" y1="46" x2="32" y2="58" stroke="${c}" stroke-width="2.2"/><line x1="6" y1="32" x2="18" y2="32" stroke="${c}" stroke-width="2.2"/><line x1="46" y1="32" x2="58" y2="32" stroke="${c}" stroke-width="2.2"/>`;
      break;
    case 'hull_breaker':
      inner = `<polygon points="32,8 54,18 54,46 32,58 10,46 10,18" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/><path d="M24 22 L32 32 L26 38 L38 50" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'crit_damage_boost':
      inner = `<polygon points="32,4 39,24 60,24 43,36 50,56 32,44 14,56 21,36 4,24 25,24" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/><polygon points="32,16 36,28 48,28 38,35 42,47 32,40 22,47 26,35 16,28 28,28" fill="${c}" stroke="none"/>`;
      break;
    case 'slipstream':
      inner = `<path d="M10,40 Q22,40 28,28 Q34,16 50,16" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="4,3"/><polygon points="46,8 58,16 46,24" fill="${c}"/>`;
      break;
    case 'momentum_strikes':
      inner = `<polygon points="14,32 38,18 32,32 38,46" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/><polygon points="34,16 52,4 46,18 56,28" fill="${c}" stroke="none"/>`;
      break;
    case 'evasive_plating':
      inner = `<path d="M32 6 L52 14 V32 C52 44 44 52 32 58 C20 52 12 44 12 32 V14 Z" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M20 30 L28 38 L44 20" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'afterburn':
      inner = `<polygon points="16,32 36,20 30,32 36,44" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="46" cy="32" r="10" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="3,3"/>`;
      break;
    case 'overcharged_drift':
      inner = `<line x1="8" y1="32" x2="56" y2="32" stroke="${c}" stroke-width="2.4"/><circle cx="24" cy="32" r="5" fill="none" stroke="${c}" stroke-width="1.8"/><circle cx="42" cy="32" r="5" fill="none" stroke="${c}" stroke-width="1.8"/><polygon points="50,26 60,32 50,38" fill="${c}"/>`;
      break;
    default:
      inner = `<circle cx="32" cy="32" r="20" fill="none" stroke="${c}" stroke-width="2.5"/>`;
  }
  svgHost.innerHTML = `<svg viewBox="0 0 64 64" width="100%" height="100%">${inner}</svg>`;
}

function showUpgradeScreen(){
  gameState = STATE.UPGRADE;
  const options = pickUpgradeOptions();
  const row = document.getElementById('card-row');
  row.innerHTML = '';
  options.forEach(({upgrade, tier})=>{
    const isAbility = upgrade.category === 'ability';
    const tierDef = isAbility ? null : TIER_DEFS[tier];
    const effect = isAbility ? upgrade.getEffect() : upgrade.getEffect(tier);
    const card = document.createElement('div');
    card.className = isAbility ? 'upgrade-card ability-card' : `upgrade-card ${tierDef.cssClass}`;
    const badgeHtml = isAbility
      ? `<div class="tier-badge ability-badge">ABILITY</div>`
      : `<div class="tier-badge ${tierDef.cssClass}-badge">${tierDef.label}</div>`;
    card.innerHTML = `
      ${badgeHtml}
      <div class="icon-box"></div>
      <div class="uname">${upgrade.name}</div>
      <div class="udesc">${upgrade.descBase}</div>
      <div class="ueffect">${effect.text}</div>
      <div class="utag">${upgrade.tag} &middot; ${upgrade.rarity}</div>
    `;
    drawUpgradeIcon(card.querySelector('.icon-box'), upgrade.iconColor, upgrade.id);
    card.addEventListener('click', ()=>{
      if(isAbility){
        upgrade.apply();
        ownedUpgrades[upgrade.id] = (ownedUpgrades[upgrade.id]||0)+1;
      } else {
        upgrade.apply(tier);
        ownedUpgrades[upgrade.id] = (ownedUpgrades[upgrade.id]||0)+1;
      }
      runStats.upgradesChosen++;
      updateWeaponNameDisplay();
      document.getElementById('upgrade-screen').classList.add('hidden');
      gameState = STATE.PLAYING;
    });
    row.appendChild(card);
  });
  document.getElementById('upgrade-screen').classList.remove('hidden');
}

function updateWeaponNameDisplay(){
  const mods = [];
  if(weapon.spread > 1) mods.push(`x${weapon.spread} SPREAD`);
  if(weapon.piercing) mods.push('PHASE');
  if(weapon.explosive) mods.push('FRAG');
  if(weapon.chainReactor) mods.push('CHAIN');
  if(drones.length > 0) mods.push(`DRONE x${drones.length}`);
  if(weapon.rapidLevel > 0) mods.push(`RATE+${weapon.rapidLevel}`);
  document.getElementById('weapon-mods').textContent = mods.join('  ·  ');
}

/* ============================================================
   COLLISIONS
============================================================ */
function circleHit(x1,y1,r1,x2,y2,r2){
  return dist2(x1,y1,x2,y2) < (r1+r2)*(r1+r2);
}

function damagePlayer(amount){
  if(player.invuln > 0) return;
  if(player.shieldCharge > 0){
    player.shieldCharge -= 1;
    player.invuln = 600;
    runStats.shieldBlocks++;
    spawnExplosion(CX, CY, 'cyan', 14, true);
    return;
  }
  if(player.sparePartsChance > 0 && Math.random() < player.sparePartsChance){
    // hit got past the shield, but Spare Parts absorbs it instead of costing a life
    player.invuln = player.invulnDuration;
    runStats.shieldBlocks++; // counted alongside shield blocks in the "hits avoided" stat
    spawnExplosion(CX, CY, 'green', 14, true);
    return;
  }
  if(player.evasivePlatingBonus > 0){
    const speedRatio = player.maxSpeed > 0 ? Math.min(1, player.speed / player.maxSpeed) : 0;
    if(Math.random() < player.evasivePlatingBonus * speedRatio){
      // moving fast enough that the hit grazes past without costing a life
      player.invuln = player.invulnDuration;
      runStats.shieldBlocks++;
      spawnExplosion(CX, CY, 'cyan', 14, true);
      return;
    }
  }
  player.lives -= amount;
  player.invuln = player.invulnDuration;
  runStats.hitsTaken++;
  spawnExplosion(CX, CY, 'magenta', 18, true);
  if(player.lives <= 0){
    triggerDeath();
  }
}

function triggerDeath(){
  gameState = STATE.DEAD;
  document.getElementById('pause-hint').classList.add('hidden');
  renderStatGrid('death-stats-left', buildShipStatRows());
  renderKillLog('death-kill-log', 'death-kill-total');
  document.getElementById('death-screen').classList.remove('hidden');
}

function addScore(amount){
  const bonusAmount = amount * (1 + player.scoreBonusPct/100);
  score += bonusAmount;
  document.getElementById('score-value').textContent = Math.floor(score);
  if(score >= nextUpgradeAt){
    nextUpgradeAt = Math.round(nextUpgradeAt * 1.3);
    document.getElementById('next-upgrade-value').textContent = Math.floor(nextUpgradeAt);
    showUpgradeScreen();
  }
  document.getElementById('next-upgrade-value').textContent = Math.floor(nextUpgradeAt);
}

/* ============================================================
   UPDATE LOOP
============================================================ */
let lastTime = performance.now();

function update(dt){
  if(gameState !== STATE.PLAYING) return;

  elapsedTime += dt/1000;

  // --- player rotation toward mouse ---
  const targetAngle = Math.atan2(mouseY - CY, mouseX - CX);
  player.angle = targetAngle; // instant facing, as specified (always faces cursor)

  // --- movement input ---
  let ix = 0, iy = 0;
  if(keys['KeyW']) iy -= 1;
  if(keys['KeyS']) iy += 1;
  if(keys['KeyA']) ix -= 1;
  if(keys['KeyD']) ix += 1;
  if(ix !== 0 || iy !== 0){
    const len = Math.hypot(ix,iy);
    ix /= len; iy /= len;
    player.vx += ix * player.accel;
    player.vy += iy * player.accel;
    player.thrusterPulse = Math.min(1, player.thrusterPulse + 0.15);
  } else {
    player.thrusterPulse *= 0.85;
  }
  // friction
  player.vx *= player.friction;
  player.vy *= player.friction;
  // clamp speed
  const sp = Math.hypot(player.vx, player.vy);
  if(sp > player.maxSpeed){
    player.vx = (player.vx/sp)*player.maxSpeed;
    player.vy = (player.vy/sp)*player.maxSpeed;
  }
  player.speed = Math.hypot(player.vx, player.vy);

  // shift the world opposite to player velocity (illusion of ship moving)
  worldShiftX += player.vx;
  worldShiftY += player.vy;

  // --- firing ---
  if(mouseDown){
    fireWeapon();
  }

  // --- invulnerability timer ---
  if(player.invuln > 0) player.invuln -= dt;
  if(abilityCooldownRemaining > 0) abilityCooldownRemaining -= dt;

  // --- update projectiles (world space) ---
  for(let i=projectiles.length-1;i>=0;i--){
    const p = projectiles[i];
    p.x += p.vx; p.y += p.vy;
    p.life -= dt;
    if(p.life <= 0){ projectiles.splice(i,1); continue; }
  }

  // --- update asteroids ---
  for(let i=asteroids.length-1;i>=0;i--){
    const a = asteroids[i];
    a.x += a.vx; a.y += a.vy;
    a.rotation += a.rotSpeed;
    if(a.hitFlash > 0) a.hitFlash -= dt;

    // cull if very far away
    if(dist2(a.x,a.y,worldShiftX,worldShiftY) > Math.pow(Math.max(W,H)*1.6,2)){
      asteroids.splice(i,1); continue;
    }

    // collide with player
    const screenX = a.x - worldShiftX + CX;
    const screenY = a.y - worldShiftY + CY;
    if(circleHit(screenX,screenY,a.radius, CX,CY,player.radius)){
      damagePlayer(1);
      // push asteroid away a bit & treat as a light hit
      a.hp -= 1;
      a.hitFlash = 150;
      if(a.hp <= 0){
        spawnExplosion(screenX,screenY,'grey',14,a.size==='large');
        trackKill(a.size==='large' ? 'ast_large' : a.size==='medium' ? 'ast_medium' : 'ast_small');
        splitAsteroid(a);
        asteroids.splice(i,1);
      }
      continue;
    }
  }

  // --- update enemies ---
  const now = performance.now();
  for(let i=enemies.length-1;i>=0;i--){
    const e = enemies[i];
    e.spawnT += dt;
    if(e.hitFlash > 0) e.hitFlash -= dt;

    const toPlayerAngle = angleTo(e.x,e.y, worldShiftX, worldShiftY);
    const d = Math.sqrt(dist2(e.x,e.y,worldShiftX,worldShiftY));

    if(e.type === 'drifter'){
      e.x += Math.cos(toPlayerAngle)*e.speed;
      e.y += Math.sin(toPlayerAngle)*e.speed;
      e.angle = toPlayerAngle;
    } else if(e.type === 'tank'){
      // same ramming behavior as a drifter, just slower and far tougher
      e.x += Math.cos(toPlayerAngle)*e.speed;
      e.y += Math.sin(toPlayerAngle)*e.speed;
      e.angle = toPlayerAngle;
    } else if(e.type === 'hunter'){
      e.x += Math.cos(toPlayerAngle)*e.speed;
      e.y += Math.sin(toPlayerAngle)*e.speed;
      e.angle = toPlayerAngle;
      if(now - e.lastFire > e.fireRate && d < 700){
        e.lastFire = now;
        enemyFire(e, toPlayerAngle);
      }
    } else if(e.type === 'turret'){
      if(d > e.preferredRange + 30){
        e.x += Math.cos(toPlayerAngle)*e.speed;
        e.y += Math.sin(toPlayerAngle)*e.speed;
      } else if(d < e.preferredRange - 30){
        e.x -= Math.cos(toPlayerAngle)*e.speed;
        e.y -= Math.sin(toPlayerAngle)*e.speed;
      }
      e.angle = toPlayerAngle;
      if(now - e.lastFire > e.fireRate && d < e.preferredRange + 200){
        e.lastFire = now;
        enemyFire(e, toPlayerAngle);
      }
    } else if(e.type === 'boss'){
      if(d > 380){
        e.x += Math.cos(toPlayerAngle)*e.speed;
        e.y += Math.sin(toPlayerAngle)*e.speed;
      }
      e.angle = toPlayerAngle;
      if(now - e.lastFire > e.fireRate){
        e.lastFire = now;
        // boss fires a 3-way burst that slowly rotates
        e.burstAngle += 0.35;
        for(let k=-1;k<=1;k++){
          enemyFire(e, toPlayerAngle + k*0.3 + Math.sin(e.burstAngle)*0.2);
        }
      }
    } else if(e.type === 'marksman'){
      // holds long range like a turret
      if(d > e.preferredRange + 30){
        e.x += Math.cos(toPlayerAngle)*e.speed;
        e.y += Math.sin(toPlayerAngle)*e.speed;
      } else if(d < e.preferredRange - 30){
        e.x -= Math.cos(toPlayerAngle)*e.speed;
        e.y -= Math.sin(toPlayerAngle)*e.speed;
      }
      if(e.laserState === 'idle'){
        e.angle = toPlayerAngle;
        if(now - e.lastFire > e.fireRate){
          e.laserState = 'telegraph';
          e.laserTimer = e.telegraphDuration;
          e.laserAngle = toPlayerAngle; // lock the line through the player's current position
        }
      } else if(e.laserState === 'telegraph'){
        e.laserTimer -= dt;
        if(e.laserTimer <= 0){
          e.laserState = 'firing';
          e.laserTimer = 220; // brief duration the damaging beam is actually live
        }
      } else if(e.laserState === 'firing'){
        e.laserTimer -= dt;
        if(e.laserTimer <= 0){
          e.laserState = 'idle';
          e.lastFire = now;
        }
      }
    }

    // cull far away (except boss/marksman, which persist)
    if(e.type !== 'boss' && e.type !== 'marksman' && dist2(e.x,e.y,worldShiftX,worldShiftY) > Math.pow(Math.max(W,H)*1.7,2)){
      enemies.splice(i,1); continue;
    }

    // collide with player
    const screenX = e.x - worldShiftX + CX;
    const screenY = e.y - worldShiftY + CY;
    if(circleHit(screenX,screenY,e.radius, CX,CY,player.radius)){
      damagePlayer(e.type==='boss' ? 1 : 1);
      e.hp -= 2;
      e.hitFlash = 150;
      if(e.hp <= 0){
        killEnemy(e, i, screenX, screenY);
      }
    }

    // marksman's beam damages the player while actively firing (line-vs-point check)
    if(e.type === 'marksman' && e.laserState === 'firing'){
      // distance from the player (always at CX,CY on screen / worldShiftX,Y in world) to the infinite line
      // through the marksman's position at angle e.laserAngle
      const lineDirX = Math.cos(e.laserAngle), lineDirY = Math.sin(e.laserAngle);
      const toPlayerX = worldShiftX - e.x, toPlayerY = worldShiftY - e.y;
      const perpDist = Math.abs(toPlayerX*lineDirY - toPlayerY*lineDirX);
      const alongDist = toPlayerX*lineDirX + toPlayerY*lineDirY;
      if(perpDist < (player.radius + 4) && alongDist > 0){
        damagePlayer(1);
      }
    }
  }

  // --- enemy projectiles vs player handled inside enemyBullets array (reuse particles? use separate list) ---
  for(let i=enemyBullets.length-1;i>=0;i--){
    const b = enemyBullets[i];
    b.x += b.vx; b.y += b.vy;
    b.life -= dt;
    if(b.life <= 0){ enemyBullets.splice(i,1); continue; }
    const screenX = b.x - worldShiftX + CX;
    const screenY = b.y - worldShiftY + CY;
    if(circleHit(screenX,screenY,b.radius, CX,CY,player.radius)){
      damagePlayer(1);
      spawnExplosion(screenX,screenY, 'amber', 6, false);
      enemyBullets.splice(i,1);
      continue;
    }
    if(dist2(b.x,b.y,worldShiftX,worldShiftY) > Math.pow(Math.max(W,H)*1.3,2)){
      enemyBullets.splice(i,1);
    }
  }

  // --- projectile collisions vs asteroids/enemies (spatial-grid accelerated) ---
  // Build the grid once per frame, then for each projectile only test the
  // small set of asteroids/enemies whose cell is near it. The actual hit
  // test (circleHit) and all resulting game logic is unchanged.
  asteroidGrid = buildSpatialGrid([asteroids]);
  enemyGrid = buildSpatialGrid([enemies]);

  // --- afterburn: passive damage to anything close while moving fast ---
  if(player.afterburnDamage > 0){
    player.afterburnTimer -= dt;
    const speedRatio = player.maxSpeed > 0 ? Math.min(1, player.speed / player.maxSpeed) : 0;
    if(player.afterburnTimer <= 0 && speedRatio > 0.6){
      player.afterburnTimer = 150; // tick rate, independent of frame rate
      const nearbyEnemies = gridQuery(enemyGrid, worldShiftX, worldShiftY, player.afterburnRadius);
      for(const e of nearbyEnemies){
        if(dist2(e.x,e.y,worldShiftX,worldShiftY) < player.afterburnRadius*player.afterburnRadius){
          e.hp -= player.afterburnDamage;
          e.hitFlash = 100;
          if(e.hp <= 0){
            const ei = enemies.indexOf(e);
            if(ei !== -1){
              const screenX = e.x - worldShiftX + CX;
              const screenY = e.y - worldShiftY + CY;
              killEnemy(e, ei, screenX, screenY);
            }
          }
        }
      }
      const nearbyAsteroids = gridQuery(asteroidGrid, worldShiftX, worldShiftY, player.afterburnRadius);
      for(const a of nearbyAsteroids){
        if(dist2(a.x,a.y,worldShiftX,worldShiftY) < player.afterburnRadius*player.afterburnRadius){
          a.hp -= player.afterburnDamage;
          a.hitFlash = 100;
          if(a.hp <= 0){
            const ai = asteroids.indexOf(a);
            if(ai !== -1){
              const screenX = a.x - worldShiftX + CX;
              const screenY = a.y - worldShiftY + CY;
              addScore(a.size === 'large' ? 60 : a.size === 'medium' ? 35 : 20);
              spawnExplosion(screenX, screenY, 'grey', 10, a.size==='large');
              trackKill(a.size==='large' ? 'ast_large' : a.size==='medium' ? 'ast_medium' : 'ast_small');
              splitAsteroid(a);
              asteroids.splice(ai,1);
            }
          }
        }
      }
    }
  }

  for(let pi=projectiles.length-1; pi>=0; pi--){
    const p = projectiles[pi];
    let consumed = false;

    const nearbyAsteroidSet = new Set(gridQuery(asteroidGrid, p.x, p.y, p.radius + 65));
    if(nearbyAsteroidSet.size > 0){
      for(let ai=asteroids.length-1; ai>=0; ai--){
        const a = asteroids[ai];
        if(!nearbyAsteroidSet.has(a)) continue;
        if(circleHit(p.x,p.y,p.radius, a.x,a.y,a.radius)){
          a.hp -= p.damage;
          a.hitFlash = 120;
          const screenX = a.x - worldShiftX + CX;
          const screenY = a.y - worldShiftY + CY;
          spawnExplosion(screenX, screenY, 'grey', 6, false);
          if(p.explosive){
            handleExplosiveImpact(a.x, a.y, weapon.explosiveRadius);
          }
          if(a.hp <= 0){
            addScore(a.size === 'large' ? 60 : a.size === 'medium' ? 35 : 20);
            spawnExplosion(screenX, screenY, 'grey', 14, a.size==='large');
            trackKill(a.size==='large' ? 'ast_large' : a.size==='medium' ? 'ast_medium' : 'ast_small');
            const dax = a.x, day = a.y;
            splitAsteroid(a);
            asteroids.splice(ai,1);
            tryChainReaction(dax, day);
          }
          if(!p.piercing){ consumed = true; break; }
          else { p.damage *= weapon.pierceDamageRetain; }
        }
      }
    }

    if(!consumed){
      const nearbyEnemySet = new Set(gridQuery(enemyGrid, p.x, p.y, p.radius + 65));
      if(nearbyEnemySet.size > 0){
        for(let ei=enemies.length-1; ei>=0; ei--){
          const e = enemies[ei];
          if(!nearbyEnemySet.has(e)) continue;
          if(circleHit(p.x,p.y,p.radius, e.x,e.y,e.radius)){
            const isHeavyTarget = e.type === 'tank' || e.type === 'boss' || e.type === 'marksman';
            const effectiveDamage = isHeavyTarget ? p.damage * (1 + weapon.hullBreakerBonus) : p.damage;
            e.hp -= effectiveDamage;
            e.hitFlash = 120;
            const screenX = e.x - worldShiftX + CX;
            const screenY = e.y - worldShiftY + CY;
            spawnExplosion(screenX, screenY, e.color, 6, false);
            if(p.explosive){
              handleExplosiveImpact(e.x, e.y, weapon.explosiveRadius);
            }
            if(e.hp <= 0){
              killEnemy(e, ei, screenX, screenY);
            }
            if(!p.piercing){ consumed = true; break; }
            else { p.damage *= weapon.pierceDamageRetain; }
          }
        }
      }
    }

    if(consumed) projectiles.splice(pi,1);
  }

  // --- particles ---
  for(let i=particles.length-1;i>=0;i--){
    const pt = particles[i];
    pt.x += pt.vx; pt.y += pt.vy;
    pt.vx *= 0.96; pt.vy *= 0.96;
    pt.life -= dt;
    if(pt.life <= 0) particles.splice(i,1);
  }

  // --- pickup texts (score popups) ---
  for(let i=pickupTexts.length-1;i>=0;i--){
    const t = pickupTexts[i];
    t.y -= 0.5;
    t.life -= dt;
    if(t.life <= 0) pickupTexts.splice(i,1);
  }

  // --- wave director ---
  updateWaveDirector(dt);

  // --- drone assist companions ---
  updateDrones(dt);

  // --- ability ordnance (missile, and any future ability projectiles) ---
  updateMissiles(dt);

  updateHUD();
}

function handleExplosiveImpact(wx, wy, radius){
  const nearbyAsteroids = asteroidGrid ? new Set(gridQuery(asteroidGrid, wx, wy, radius)) : null;
  for(let ai=asteroids.length-1; ai>=0; ai--){
    const a = asteroids[ai];
    if(nearbyAsteroids && !nearbyAsteroids.has(a)) continue;
    if(dist2(a.x,a.y,wx,wy) < radius*radius){
      a.hp -= 1;
    }
  }
  const nearbyEnemies = enemyGrid ? new Set(gridQuery(enemyGrid, wx, wy, radius)) : null;
  for(let ei=enemies.length-1; ei>=0; ei--){
    const e = enemies[ei];
    if(nearbyEnemies && !nearbyEnemies.has(e)) continue;
    if(dist2(e.x,e.y,wx,wy) < radius*radius){
      e.hp -= 1;
    }
  }
  const screenX = wx - worldShiftX + CX;
  const screenY = wy - worldShiftY + CY;
  spawnExplosion(screenX, screenY, 'amber', 10, true);
}

function killEnemy(e, idx, screenX, screenY){
  addScore(e.scoreValue);
  spawnExplosion(screenX, screenY, e.color, (e.type==='boss'||e.type==='marksman')?40:16, true);
  const statKey = (e.type === 'drifter' || e.type === 'tank') ? `${e.type}${e.tier||1}` : e.type;
  trackKill(statKey);
  const deathWorldX = e.x, deathWorldY = e.y;
  enemies.splice(idx,1);
  if(e.type === 'boss'){
    flashWaveBanner('CAPTAIN NEUTRALIZED');
  } else if(e.type === 'marksman'){
    flashWaveBanner('MARKSMAN NEUTRALIZED');
  }
  tryChainReaction(deathWorldX, deathWorldY);
}

let enemyBullets = [];
function enemyFire(e, angle){
  enemyBullets.push({
    x: e.x, y: e.y,
    vx: Math.cos(angle)*5.5,
    vy: Math.sin(angle)*5.5,
    radius: 4,
    life: 2200
  });
}

/* ============================================================
   HUD UPDATE
============================================================ */
function updateHUD(){
  const livesDiv = document.getElementById('lives');
  let html = '';
  for(let i=0;i<player.maxLives;i++){
    const filled = i < player.lives;
    html += `<svg class="life-icon" viewBox="0 0 24 24">
      <polygon points="12,3 21,9 21,17 12,21 3,17 3,9" fill="${filled?'rgba(95,227,255,0.85)':'none'}" stroke="${filled?'var(--cyan)':'var(--cyan-dim)'}" stroke-width="1.5"/>
    </svg>`;
  }
  livesDiv.innerHTML = html;

  const shieldPct = player.shieldMax > 0 ? Math.round((player.shieldCharge/player.shieldMax)*100) : 0;
  document.getElementById('shield-fill').style.width = shieldPct + '%';
  document.getElementById('shield-label').textContent = player.shieldMax > 0 ? `SHIELD  ${player.shieldCharge}/${player.shieldMax}` : 'SHIELD  —';

  const abilityReadout = document.getElementById('ability-readout');
  const ability = getEquippedAbility();
  if(!ability){
    abilityReadout.classList.add('hidden');
  } else {
    abilityReadout.classList.remove('hidden');
    const ready = abilityCooldownRemaining <= 0;
    const fillPct = ready ? 100 : Math.max(0, 100 - (abilityCooldownRemaining/ability.cooldownMs)*100);
    document.getElementById('ability-fill').style.width = fillPct + '%';
    document.getElementById('ability-fill').classList.toggle('on-cooldown', !ready);
    document.getElementById('ability-label').textContent = ready ? `SPACE — ${ability.name}` : `SPACE — ${(abilityCooldownRemaining/1000).toFixed(1)}s`;
  }
}

/* ============================================================
   RENDER
============================================================ */
function clearCanvas(){
  ctx.clearRect(0,0,W,H);
}

function drawBackground(){
  bgCtx.fillStyle = '#020208';
  bgCtx.fillRect(0,0,W,H);
  bgCtx.save();
  for(const s of stars){
    const sx = ((s.x - worldShiftX*s.depth) % (W*1.4) + W*1.4) % (W*1.4) - W*0.2;
    const sy = ((s.y - worldShiftY*s.depth) % (H*1.4) + H*1.4) % (H*1.4) - H*0.2;
    bgCtx.globalAlpha = 0.4 + s.depth*0.6;
    bgCtx.fillStyle = '#aee6ff';
    bgCtx.beginPath();
    bgCtx.arc(sx, sy, s.size, 0, Math.PI*2);
    bgCtx.fill();
  }
  bgCtx.restore();
}

function drawShip(){
  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(player.angle);

  const flicker = player.invuln > 0 && Math.floor(player.invuln/100)%2===0;
  ctx.globalAlpha = flicker ? 0.35 : 1;

  // thruster glow
  if(player.thrusterPulse > 0.05){
    ctx.save();
    ctx.globalAlpha *= player.thrusterPulse;
    const g = ctx.createRadialGradient(-14,0,0,-14,0,18);
    g.addColorStop(0,'rgba(95,227,255,0.9)');
    g.addColorStop(1,'rgba(95,227,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(-14,0,18,0,Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  // shield ring
  if(player.shieldCharge > 0){
    ctx.save();
    ctx.strokeStyle = 'rgba(95,227,255,0.55)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#5fe3ff';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(0,0,22,0,Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }

  // ship body (wireframe triangle, nose pointing along +x which equals facing angle)
  ctx.strokeStyle = '#5fe3ff';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#5fe3ff';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(18,0);
  ctx.lineTo(-12,-11);
  ctx.lineTo(-6,0);
  ctx.lineTo(-12,11);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}

function drawAsteroids(){
  ctx.save();
  for(const a of asteroids){
    const screenX = a.x - worldShiftX + CX;
    const screenY = a.y - worldShiftY + CY;
    if(screenX < -100 || screenX > W+100 || screenY < -100 || screenY > H+100) continue;

    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.rotate(a.rotation);
    ctx.strokeStyle = a.hitFlash > 0 ? '#ffffff' : '#c9d6e3';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = '#c9d6e3';
    ctx.shadowBlur = a.hitFlash > 0 ? 14 : 5;
    ctx.beginPath();
    a.shape.forEach((pt, idx)=>{
      const r = a.radius * pt.r;
      const x = Math.cos(pt.a)*r, y = Math.sin(pt.a)*r;
      if(idx===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

const enemyColorMap = {
  magenta: '#ff3d6e', purple: '#b88aff', amber: '#ffb347',
  drifter2: '#ff8c3d', drifter3: '#fff23d',
  tank1: '#7d9fc9', tank2: '#5f7ea8', tank3: '#3f5d87',
  green: '#7dff8c'
};

function drawEnemies(){
  ctx.save();
  for(const e of enemies){
    const screenX = e.x - worldShiftX + CX;
    const screenY = e.y - worldShiftY + CY;
    if(screenX < -120 || screenX > W+120 || screenY < -120 || screenY > H+120) continue;

    const col = e.hitFlash > 0 ? '#ffffff' : (enemyColorMap[e.color]||'#ff3d6e');
    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.rotate(e.angle);
    ctx.strokeStyle = col;
    ctx.lineWidth = (e.type==='boss' || e.type==='marksman') ? 2.6 : (e.type==='tank' ? 2.4 : 1.8);
    ctx.shadowColor = col;
    ctx.shadowBlur = e.hitFlash>0 ? 16 : 8;

    if(e.type === 'drifter'){
      ctx.beginPath();
      ctx.moveTo(e.radius,0);
      ctx.lineTo(-e.radius*0.7,-e.radius*0.8);
      ctx.lineTo(-e.radius*0.3,0);
      ctx.lineTo(-e.radius*0.7,e.radius*0.8);
      ctx.closePath();
      ctx.stroke();
    } else if(e.type === 'tank'){
      // heavy armored hexagonal hull with reinforcing plate lines
      ctx.beginPath();
      const sides = 6;
      for(let i=0;i<=sides;i++){
        const a2 = (i/sides)*Math.PI*2;
        const x = Math.cos(a2)*e.radius, y = Math.sin(a2)*e.radius;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
      ctx.stroke();
      // inner plating
      ctx.beginPath();
      const innerR = e.radius*0.55;
      for(let i=0;i<=sides;i++){
        const a2 = (i/sides)*Math.PI*2 + Math.PI/6;
        const x = Math.cos(a2)*innerR, y = Math.sin(a2)*innerR;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
      ctx.stroke();
      // forward marker showing facing direction
      ctx.beginPath();
      ctx.moveTo(innerR*0.3,0);
      ctx.lineTo(e.radius*0.9,0);
      ctx.stroke();
    } else if(e.type === 'hunter'){
      ctx.beginPath();
      ctx.moveTo(e.radius*1.2,0);
      ctx.lineTo(-e.radius*0.6,-e.radius);
      ctx.lineTo(-e.radius*0.9,0);
      ctx.lineTo(-e.radius*0.6,e.radius);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0,0,e.radius*0.35,0,Math.PI*2);
      ctx.stroke();
    } else if(e.type === 'turret'){
      ctx.beginPath();
      const sides = 6;
      for(let i=0;i<=sides;i++){
        const a2 = (i/sides)*Math.PI*2;
        const x = Math.cos(a2)*e.radius, y = Math.sin(a2)*e.radius;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.lineTo(e.radius*1.4,0);
      ctx.stroke();
    } else if(e.type === 'boss'){
      ctx.beginPath();
      const spikes = 5;
      for(let i=0;i<spikes;i++){
        const a2 = (i/spikes)*Math.PI*2;
        const a3 = ((i+0.5)/spikes)*Math.PI*2;
        const x1 = Math.cos(a2)*e.radius, y1 = Math.sin(a2)*e.radius;
        const x2 = Math.cos(a3)*e.radius*0.55, y2 = Math.sin(a3)*e.radius*0.55;
        if(i===0) ctx.moveTo(x1,y1); else ctx.lineTo(x1,y1);
        ctx.lineTo(x2,y2);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0,0,e.radius*0.4,0,Math.PI*2);
      ctx.stroke();

      // boss health bar
      ctx.restore();
      ctx.save();
      const barW = 90;
      ctx.translate(screenX - barW/2, screenY - e.radius - 18);
      ctx.strokeStyle = 'rgba(255,179,71,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0,0,barW,5);
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(0,0, barW*(e.hp/e.maxHp), 5);
      ctx.restore();
      continue;
    } else if(e.type === 'marksman'){
      // angular sniper-scope hull: diamond body with a long forward barrel
      ctx.beginPath();
      ctx.moveTo(e.radius*1.1,0);
      ctx.lineTo(0,-e.radius*0.65);
      ctx.lineTo(-e.radius*0.7,0);
      ctx.lineTo(0,e.radius*0.65);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0,0,e.radius*0.3,0,Math.PI*2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(e.radius*0.3,0);
      ctx.lineTo(e.radius*1.6,0);
      ctx.stroke();

      // health bar (green-themed to match its color identity)
      ctx.restore();
      ctx.save();
      const barW2 = 90;
      ctx.translate(screenX - barW2/2, screenY - e.radius - 18);
      ctx.strokeStyle = 'rgba(125,255,140,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0,0,barW2,5);
      ctx.fillStyle = '#7dff8c';
      ctx.fillRect(0,0, barW2*(e.hp/e.maxHp), 5);
      ctx.restore();
      continue;
    }
    ctx.restore();
  }
  ctx.restore();
}

/* ============================================================
   MARKSMAN LASER RENDERING — draws the thin telegraph line and
   the thick damaging beam across the full screen, along the
   locked laserAngle for any marksman currently in those states.
============================================================ */
function drawMarksmanLasers(){
  ctx.save();
  for(const e of enemies){
    if(e.type !== 'marksman') continue;
    if(e.laserState !== 'telegraph' && e.laserState !== 'firing') continue;

    const screenX = e.x - worldShiftX + CX;
    const screenY = e.y - worldShiftY + CY;
    const dirX = Math.cos(e.laserAngle), dirY = Math.sin(e.laserAngle);
    // extend the line far enough to always cross the whole visible screen
    const reach = Math.max(W,H) * 1.6;
    const x1 = screenX - dirX*reach, y1 = screenY - dirY*reach;
    const x2 = screenX + dirX*reach, y2 = screenY + dirY*reach;

    if(e.laserState === 'telegraph'){
      // thin warning line — shows exactly where the beam will fire
      const pulse = 0.5 + 0.5*Math.sin(performance.now()/90);
      ctx.strokeStyle = `rgba(125,255,140,${0.35 + pulse*0.25})`;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = '#7dff8c';
      ctx.shadowBlur = 6;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(x1,y1);
      ctx.lineTo(x2,y2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if(e.laserState === 'firing'){
      // thick damaging beam
      ctx.strokeStyle = 'rgba(125,255,140,0.95)';
      ctx.lineWidth = 9;
      ctx.shadowColor = '#7dff8c';
      ctx.shadowBlur = 24;
      ctx.beginPath();
      ctx.moveTo(x1,y1);
      ctx.lineTo(x2,y2);
      ctx.stroke();
      // bright hot core
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(x1,y1);
      ctx.lineTo(x2,y2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawProjectiles(){
  ctx.save();
  for(const p of projectiles){
    const screenX = p.x - worldShiftX + CX;
    const screenY = p.y - worldShiftY + CY;
    ctx.strokeStyle = p.isCrit ? '#fff8dc' : (p.explosive ? '#ffb347' : (p.piercing ? '#b88aff' : '#5fe3ff'));
    ctx.lineWidth = p.isCrit ? p.radius + 1.5 : p.radius;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = p.isCrit ? 14 : 8;
    ctx.beginPath();
    ctx.moveTo(screenX - p.vx*1.4, screenY - p.vy*1.4);
    ctx.lineTo(screenX, screenY);
    ctx.stroke();
  }
  for(const b of enemyBullets){
    const screenX = b.x - worldShiftX + CX;
    const screenY = b.y - worldShiftY + CY;
    ctx.fillStyle = '#ff3d6e';
    ctx.shadowColor = '#ff3d6e';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(screenX, screenY, b.radius, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

const particleColorMap = {
  cyan: '#5fe3ff', magenta: '#ff3d6e', grey: '#c9d6e3', amber: '#ffb347',
  white: '#e8f4ff', purple: '#b88aff'
};

function drawParticles(){
  ctx.save();
  for(const pt of particles){
    const alpha = Math.max(0, pt.life/pt.maxLife);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = particleColorMap[pt.color] || '#fff';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function render(){
  drawBackground();
  clearCanvas();
  drawAsteroids();
  drawEnemies();
  drawMarksmanLasers();
  drawProjectiles();
  drawMissiles();
  drawDrones();
  drawParticles();
  drawShip();
}

/* ============================================================
   MAIN LOOP
============================================================ */
function loop(now){
  const dt = Math.min(40, now - lastTime); // clamp dt to avoid big jumps
  lastTime = now;

  if(gameState === STATE.PLAYING){
    update(dt);
  }
  render();
  requestAnimationFrame(loop);
}

/* ============================================================
   GAME LIFECYCLE
============================================================ */
function resetGame(){
  score = 0;
  nextUpgradeAt = 1500;
  waveLevel = 1;
  elapsedTime = 0;
  bossSpawnedAtWave = 0;
  swarmActive = false;
  swarmTimeRemaining = 0;
  swarmSpawnTimer = 0;
  worldShiftX = 0; worldShiftY = 0;
  player.angle = 0; player.vx = 0; player.vy = 0;
  player.lives = 3; player.maxLives = 5;
  player.invuln = 0; player.shieldCharge = 0; player.shieldMax = 0;
  player.invulnDuration = 1100; player.sparePartsChance = 0; player.scoreBonusPct = 0;
  weapon.fireRate = 230; weapon.damage = 1; weapon.spread = 1;
  weapon.speed = 9.5; weapon.piercing = false; weapon.explosive = false;
  weapon.explosiveRadius = 55; weapon.rapidLevel = 0; weapon.speedLevel = 0;
  weapon.critChance = 0; weapon.projSize = 3;
  weapon.critMultiplier = 2.5; weapon.hullBreakerBonus = 0;
  weapon.slipstreamBonus = 0; weapon.momentumBonus = 0; weapon.driftPierceBonus = 0;
  player.evasivePlatingBonus = 0; player.afterburnDamage = 0; player.afterburnRadius = 0; player.afterburnTimer = 0;
  player.speed = 0;
  player.maxSpeed = 4.4; player.accel = 0.32;
  asteroids = []; enemies = []; projectiles = []; particles = []; enemyBullets = [];
  drones = []; droneBullets = [];
  missiles = [];
  equippedAbilityId = null;
  abilityCooldownRemaining = 0;
  for(const key in ownedAbilities) delete ownedAbilities[key];
  weapon.chainReactor = false; weapon.chainChance = 0; weapon.chainRadius = 0;
  weapon.pierceDamageRetain = 0.7;
  pickupTexts = [];
  spawnTimer = 0;
  runStats.killsByType = {};
  runStats.totalKills = 0;
  runStats.shotsFired = 0;
  runStats.hitsTaken = 0;
  runStats.shieldBlocks = 0;
  runStats.upgradesChosen = 0;
  initStars();
  document.getElementById('score-value').textContent = '0';
  document.getElementById('next-upgrade-value').textContent = '1500';
  document.getElementById('weapon-mods').textContent = '';
  updateHUD();

  // seed a few asteroids so it's not empty at start
  for(let i=0;i<6;i++) spawnAsteroid();
}

document.getElementById('start-btn').addEventListener('click', ()=>{
  document.getElementById('start-screen').classList.add('hidden');
  resetGame();
  gameState = STATE.PLAYING;
  document.getElementById('pause-hint').classList.remove('hidden');
});

document.getElementById('restart-btn').addEventListener('click', ()=>{
  document.getElementById('death-screen').classList.add('hidden');
  resetGame();
  gameState = STATE.PLAYING;
  document.getElementById('pause-hint').classList.remove('hidden');
});

document.getElementById('resume-btn').addEventListener('click', ()=>{
  togglePause();
});

function returnToMainMenu(){
  gameState = STATE.MENU;
  document.getElementById('pause-screen').classList.add('hidden');
  document.getElementById('death-screen').classList.add('hidden');
  document.getElementById('pause-hint').classList.add('hidden');
  resetGame();
  document.getElementById('start-screen').classList.remove('hidden');
}

document.getElementById('quit-to-menu-btn').addEventListener('click', returnToMainMenu);
document.getElementById('death-menu-btn').addEventListener('click', returnToMainMenu);

/* ============================================================
   ENEMY GUIDE & EVENT GUIDE DATA
============================================================ */
const ENEMY_GUIDE = [
  {
    id: 'ast_large', name: 'LARGE ASTEROID', score: '60 PTS',
    desc: 'A slow, drifting mass of rock. Splits into two medium asteroids when destroyed.',
    tag: 'HAZARD', iconKind: 'asteroid', iconSize: 1.0
  },
  {
    id: 'ast_medium', name: 'MEDIUM ASTEROID', score: '35 PTS',
    desc: 'A fragment from a larger rock. Splits into two small asteroids when destroyed.',
    tag: 'HAZARD', iconKind: 'asteroid', iconSize: 0.72
  },
  {
    id: 'ast_small', name: 'SMALL ASTEROID', score: '20 PTS',
    desc: 'The last fragment of a broken asteroid. Breaks apart completely when destroyed.',
    tag: 'HAZARD', iconKind: 'asteroid', iconSize: 0.5
  },
  {
    id: 'drifter1', name: 'DRIFTER', score: '80 PTS',
    desc: 'A slow hostile that drifts straight toward you and rams on contact. No weapons of its own.',
    tag: 'HOSTILE', iconKind: 'drifter', iconColor: '#ff3d6e'
  },
  {
    id: 'drifter2', name: 'DRIFTER MK.II', score: '95 PTS',
    desc: 'A faster variant of the standard drifter. Same ramming behavior, quicker approach.',
    tag: 'HOSTILE', iconKind: 'drifter', iconColor: '#ff8c3d'
  },
  {
    id: 'drifter3', name: 'DRIFTER MK.III', score: '110 PTS',
    desc: 'The fastest drifter variant. Closes distance quickly — don’t let it sneak up on you.',
    tag: 'HOSTILE', iconKind: 'drifter', iconColor: '#fff23d'
  },
  {
    id: 'hunter', name: 'HUNTER', score: '140 PTS',
    desc: 'Actively chases you down and fires aimed shots once it’s within range. More dangerous than it looks.',
    tag: 'HOSTILE', iconKind: 'hunter', iconColor: '#ff3d6e'
  },
  {
    id: 'turret', name: 'TURRET', score: '160 PTS',
    desc: 'Holds its distance and fires aimed shots from range. Closes in only if you stray too far.',
    tag: 'HOSTILE', iconKind: 'turret', iconColor: '#b88aff'
  },
  {
    id: 'tank1', name: 'TANK', score: '220 PTS',
    desc: 'A heavily armored hull that lumbers straight at you. Slower than a drifter, but absorbs far more damage — easy to dodge, costly to ignore.',
    tag: 'HOSTILE', iconKind: 'tank', iconColor: '#7d9fc9'
  },
  {
    id: 'tank2', name: 'TANK MK.II', score: '260 PTS',
    desc: 'A bigger, even slower tank with a noticeably tougher hull than the original.',
    tag: 'HOSTILE', iconKind: 'tank', iconColor: '#5f7ea8'
  },
  {
    id: 'tank3', name: 'TANK MK.III', score: '300 PTS',
    desc: 'The heaviest tank variant — barely moves, but its hull strength makes it the toughest non-boss target in the field.',
    tag: 'HOSTILE', iconKind: 'tank', iconColor: '#3f5d87'
  },
  {
    id: 'boss', name: 'THE CAPTAIN', score: '1200 PTS',
    desc: 'A heavy combatant that holds back and unleashes a rotating triple-shot burst. High hull strength.',
    tag: 'BOSS', iconKind: 'boss', iconColor: '#ffb347'
  },
  {
    id: 'marksman', name: 'THE MARKSMAN', score: '1400 PTS',
    desc: 'Holds long range and locks onto your position with a thin warning line before firing a full-screen beam along that exact path. Move out of the line before it fires.',
    tag: 'BOSS', iconKind: 'marksman', iconColor: '#7dff8c'
  },
];

const EVENT_GUIDE = [
  {
    id: 'captain_event', name: 'CAPTAIN INBOUND', score: 'EVERY 5000 PTS',
    desc: 'One of three random outcomes at this milestone. The Captain holds its distance and fires rotating bursts — stay mobile and keep landing hits until its hull gives out.',
    tag: 'EVENT'
  },
  {
    id: 'swarm_event', name: 'WAVE OF DRIFTERS', score: 'EVERY 5000 PTS',
    desc: 'One of three random outcomes at this milestone. For 10 seconds, drifters of all three speeds flood in on top of the normal field. Asteroids and other enemies keep spawning as usual — it just gets a lot more crowded.',
    tag: 'EVENT'
  },
  {
    id: 'marksman_event', name: 'MARKSMAN INBOUND', score: 'EVERY 5000 PTS',
    desc: 'One of three random outcomes at this milestone. The Marksman appears and locks a full-screen laser onto your position — watch for the thin warning line and move before the real beam fires.',
    tag: 'EVENT'
  },
];

function drawSimpleEnemyIcon(svgHost, entry){
  let inner = '';
  if(entry.iconKind === 'asteroid'){
    const r = 26 * entry.iconSize;
    const pts = [];
    const sides = 9;
    for(let i=0;i<sides;i++){
      const a = (i/sides)*Math.PI*2;
      const rr = r * (0.75 + (i%3===0?0.25:0));
      pts.push(`${32+Math.cos(a)*rr},${32+Math.sin(a)*rr}`);
    }
    inner = `<polygon points="${pts.join(' ')}" fill="none" stroke="#c9d6e3" stroke-width="2"/>`;
  } else if(entry.iconKind === 'drifter'){
    inner = `<polygon points="46,32 14,16 22,32 14,48" fill="none" stroke="${entry.iconColor}" stroke-width="2.2" stroke-linejoin="round"/>`;
  } else if(entry.iconKind === 'hunter'){
    inner = `<polygon points="48,32 12,12 6,32 12,52" fill="none" stroke="${entry.iconColor}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="24" cy="32" r="6" fill="none" stroke="${entry.iconColor}" stroke-width="2"/>`;
  } else if(entry.iconKind === 'turret'){
    inner = `<polygon points="32,8 50,18 50,46 32,56 14,46 14,18" fill="none" stroke="${entry.iconColor}" stroke-width="2.2" stroke-linejoin="round"/><line x1="32" y1="32" x2="54" y2="32" stroke="${entry.iconColor}" stroke-width="2.2"/>`;
  } else if(entry.iconKind === 'boss'){
    inner = `<polygon points="32,6 42,24 60,28 46,40 50,58 32,48 14,58 18,40 4,28 22,24" fill="none" stroke="${entry.iconColor}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="32" cy="32" r="8" fill="none" stroke="${entry.iconColor}" stroke-width="2"/>`;
  } else if(entry.iconKind === 'tank'){
    inner = `<polygon points="32,6 54,18 54,46 32,58 10,46 10,18" fill="none" stroke="${entry.iconColor}" stroke-width="2.4" stroke-linejoin="round"/><polygon points="32,18 44,25 44,39 32,46 20,39 20,25" fill="none" stroke="${entry.iconColor}" stroke-width="1.8" stroke-linejoin="round"/>`;
  } else if(entry.iconKind === 'marksman'){
    inner = `<polygon points="54,32 32,12 10,32 32,52" fill="none" stroke="${entry.iconColor}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="32" cy="32" r="6" fill="none" stroke="${entry.iconColor}" stroke-width="2"/><line x1="38" y1="32" x2="60" y2="32" stroke="${entry.iconColor}" stroke-width="2"/>`;
  }
  svgHost.innerHTML = `<svg viewBox="0 0 64 64" width="100%" height="100%">${inner}</svg>`;
}

function buildEnemyGuide(){
  const grid = document.getElementById('enemy-guide-grid');
  grid.innerHTML = '';
  ENEMY_GUIDE.forEach(entry=>{
    const card = document.createElement('div');
    card.className = 'guide-card';
    card.innerHTML = `
      <div class="gc-header">
        <div class="gc-icon"></div>
        <div>
          <div class="gc-name">${entry.name}</div>
          <div class="gc-score">${entry.score}</div>
        </div>
      </div>
      <div class="gc-desc">${entry.desc}</div>
      <div class="gc-tag">${entry.tag}</div>
    `;
    drawSimpleEnemyIcon(card.querySelector('.gc-icon'), entry);
    grid.appendChild(card);
  });

  const eventGrid = document.getElementById('event-guide-grid');
  eventGrid.innerHTML = '';
  EVENT_GUIDE.forEach(entry=>{
    const card = document.createElement('div');
    card.className = 'guide-card event-card';
    card.innerHTML = `
      <div class="gc-header">
        <div>
          <div class="gc-name">${entry.name}</div>
          <div class="gc-score">${entry.score}</div>
        </div>
      </div>
      <div class="gc-desc">${entry.desc}</div>
      <div class="gc-tag">${entry.tag}</div>
    `;
    eventGrid.appendChild(card);
  });
}

function buildStatModGuide(){
  const sectionsContainer = document.getElementById('statmod-sections');
  sectionsContainer.innerHTML = '';

  // Snapshot the live weapon/drones state, temporarily reset to a fresh-run
  // baseline so every tier's effect text describes what a player would see
  // picking that upgrade from scratch — then restore the real state after.
  // (getEffect() never mutates on its own; this only guards against a couple
  // of upgrades, like Phase Rounds, Drone Assist, and Overcharged Crit,
  // whose display text reads current weapon/drone state to describe
  // "what happens next".)
  const snapshot = {
    piercing: weapon.piercing,
    pierceDamageRetain: weapon.pierceDamageRetain,
    critChance: weapon.critChance,
    critMultiplier: weapon.critMultiplier,
    dronesLength: drones.length
  };
  weapon.piercing = false;
  weapon.pierceDamageRetain = 0.7;
  weapon.critChance = 0.05; // so Overcharged Crit's gated preview text has something to show
  weapon.critMultiplier = 2.5;
  const realDrones = drones;
  drones = [];

  function buildCard(opt){
    const card = document.createElement('div');
    card.className = 'guide-card';
    const tierRows = TIER_ORDER.map(tierKey => {
      const tierDef = TIER_DEFS[tierKey];
      const effect = opt.getEffect(tierKey);
      return `
        <div class="gc-tier-row row-${tierKey}">
          <span class="gc-tier-label">${tierDef.label}</span>
          <span class="gc-tier-chance">${tierDef.weight}%</span>
          <span class="gc-tier-effect">${effect.text}</span>
        </div>
      `;
    }).join('');
    card.innerHTML = `
      <div class="gc-header">
        <div class="gc-icon"></div>
        <div class="gc-name">${opt.name}</div>
      </div>
      <div class="gc-desc">${opt.descBase}</div>
      <div class="gc-tier-breakdown">${tierRows}</div>
      <div class="gc-tag">${opt.tag} &middot; ${opt.rarity}</div>
    `;
    drawUpgradeIcon(card.querySelector('.gc-icon'), opt.iconColor, opt.id);
    return card;
  }

  function addSection(headingText, subText, colorName, cards){
    const heading = document.createElement('div');
    heading.className = `statmod-section-heading color-${colorName}`;
    heading.textContent = headingText;
    sectionsContainer.appendChild(heading);

    if(subText){
      const sub = document.createElement('div');
      sub.className = 'statmod-section-sub';
      sub.textContent = subText;
      sectionsContainer.appendChild(sub);
    }

    const grid = document.createElement('div');
    grid.className = 'guide-grid';
    cards.forEach(opt => grid.appendChild(buildCard(opt)));
    sectionsContainer.appendChild(grid);
  }

  // Basics first — simple, universal, no build commitment required
  const basics = UPGRADE_POOL.filter(opt => opt.cardType === 'nonfamily');
  addSection('BASICS', 'Simple, reliable stat boosts available to everyone.', 'grey', basics);

  // Then each family, in the order they're registered in FAMILY_DEFS
  for(const familyKey in FAMILY_DEFS){
    const familyDef = FAMILY_DEFS[familyKey];
    const familyCards = UPGRADE_POOL.filter(opt => opt.cardType === 'family' && opt.family === familyKey);
    if(familyCards.length === 0) continue;
    addSection(`${familyDef.label} SPECIALIZATION`, 'Lean into these together — they build on each other.', familyDef.color, familyCards);
  }

  // restore real state
  weapon.piercing = snapshot.piercing;
  weapon.pierceDamageRetain = snapshot.pierceDamageRetain;
  weapon.critChance = snapshot.critChance;
  weapon.critMultiplier = snapshot.critMultiplier;
  drones = realDrones;
}

function buildBuildGuide(){
  const grid = document.getElementById('build-guide-grid');
  grid.innerHTML = '';

  ABILITY_POOL.forEach(opt=>{
    const card = document.createElement('div');
    card.className = 'guide-card ability-guide-card';
    card.innerHTML = `
      <div class="gc-header">
        <div class="gc-icon"></div>
        <div class="gc-name">${opt.name}</div>
      </div>
      <div class="gc-desc">${opt.descBase}</div>
      <div class="gc-ability-effect">${opt.getEffect().text}</div>
      <div class="gc-tag">${opt.tag} &middot; ${opt.rarity} &middot; SPACE TO ACTIVATE</div>
    `;
    drawUpgradeIcon(card.querySelector('.gc-icon'), opt.iconColor, opt.id);
    grid.appendChild(card);
  });
}

document.getElementById('enemy-guide-btn').addEventListener('click', ()=>{
  buildEnemyGuide();
  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('enemy-guide-screen').classList.remove('hidden');
});

document.getElementById('enemy-guide-back').addEventListener('click', ()=>{
  document.getElementById('enemy-guide-screen').classList.add('hidden');
  document.getElementById('start-screen').classList.remove('hidden');
});

document.getElementById('statmod-guide-btn').addEventListener('click', ()=>{
  buildStatModGuide();
  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('statmod-guide-screen').classList.remove('hidden');
});

document.getElementById('statmod-guide-back').addEventListener('click', ()=>{
  document.getElementById('statmod-guide-screen').classList.add('hidden');
  document.getElementById('start-screen').classList.remove('hidden');
});

document.getElementById('build-guide-btn').addEventListener('click', ()=>{
  buildBuildGuide();
  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('build-guide-screen').classList.remove('hidden');
});

document.getElementById('build-guide-back').addEventListener('click', ()=>{
  document.getElementById('build-guide-screen').classList.add('hidden');
  document.getElementById('start-screen').classList.remove('hidden');
});

initStars();
requestAnimationFrame((t)=>{ lastTime = t; requestAnimationFrame(loop); });

})();