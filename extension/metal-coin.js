'use strict';

(() => {
  const { DOM_EVENTS } = globalThis.TabOutContracts;
  const AMBIENCE_TRACE = '[tab-out ambience trace]';
  const traceAmbience = () => {};
  const coin = document.getElementById('taboutMetalCoin');
  const frontCanvas = document.getElementById('taboutCoinFront');
  const backCanvas = document.getElementById('taboutCoinBack');
  if (!coin || !frontCanvas || !backCanvas) return;

  const HEIGHT_FRONT = 'assets/images/kind.png';
  const HEIGHT_BACK = 'assets/images/evil.png';
  const SCRATCH_NORMAL = 'assets/images/coin-scratches.png';

  let requestedSide = document.body.classList.contains('pocket-coin-hidden')
    ? 'hidden'
    : 'visible';
  let syncRenderedMode = null;

  coin.addEventListener(DOM_EVENTS.POCKET_VISIBILITY_SYNC, event => {
    requestedSide = event.detail?.visible === true ? 'visible' : 'hidden';
    if (syncRenderedMode) syncRenderedMode(requestedSide);
  });

  const COIN_METAL_PARAMS = Object.freeze({
    heightContrast: 0.52,
    reliefDepth: 0.27,
    rimWidth: 0.019,
    rimHeight: 0.43,
    rimBevel: 0.018,
    normalStrength: 2.9,
    normalZ: 1.2,
    cavity: 0,
    selfShadow: 0.72,
    slopeLight: 0.09,
    baseLevel: 0.7,
    broadPower: 37,
    broadIntensity: 1.2,
    tightPower: 55,
    tightIntensity: 2.4,
    env1: 1,
    env2: 0.08,
    movingEnv: 0.29,
    softbox: 0.22,
    fresnel: 0.86,
    grain: 0,
    scratchStrength: 0.69,
    anisotropy: 0.78,
    streakIntensity: 0.78,
    streakSharpness: 2.1,
    streakAngle: -46,
    streakMotion: 0.2,
    pointerMix: 1,
    hoverMotion: 0.18,
    tiltStrength: 10,
    shadowShift: 28,
    hoverLift: 8,
  });

  const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){
  vUv=aPos*.5+.5;
  gl_Position=vec4(aPos,0.,1.);
}`;

  const FS = `
precision highp float;

uniform sampler2D uTex;
uniform sampler2D uScratchNormal;
uniform vec2 uTexSize;
uniform vec2 uRenderSize;
uniform vec2 uPointer;
uniform float uTime;
uniform float uHover;
uniform float uHeightContrast;
uniform float uReliefDepth;
uniform float uRimWidth;
uniform float uRimHeight;
uniform float uRimBevel;
uniform float uNormalStrength;
uniform float uNormalZ;
uniform float uCavity;
uniform float uSelfShadow;
uniform float uSlopeLight;
uniform float uBaseLevel;
uniform float uBroadPower;
uniform float uBroadIntensity;
uniform float uTightPower;
uniform float uTightIntensity;
uniform float uEnv1;
uniform float uEnv2;
uniform float uMovingEnv;
uniform float uSoftbox;
uniform float uFresnel;
uniform float uGrain;
uniform float uScratchStrength;
uniform float uAnisotropy;
uniform float uStreakIntensity;
uniform float uStreakSharpness;
uniform float uStreakAngle;
uniform float uStreakMotion;
uniform float uPointerMix;
uniform float uHoverMotion;

varying vec2 vUv;

vec4 sampleHeight(vec2 uv){
  // The source is square: retain the complete image without cropping or
  // introducing the old portrait-map aspect correction.
  return texture2D(uTex,uv);
}

float rawHeight(vec2 uv){
  vec4 texel=sampleHeight(uv);
  float h=dot(texel.rgb,vec3(.299,.587,.114))*texel.a;
  return pow(clamp(h,0.0,1.0),uHeightContrast);
}

float coinRimHeight(vec2 uv){
  float inset=max(.5-length(uv-.5),0.0);
  float bevel=min(uRimBevel,uRimWidth*.45);
  float outerRise=smoothstep(0.0,bevel,inset);
  float innerFall=1.0-smoothstep(uRimWidth-bevel,uRimWidth,inset);
  return outerRise*innerFall*uRimHeight;
}

float heightAt(vec2 uv){
  return max(rawHeight(uv)*uReliefDepth,coinRimHeight(uv));
}

void main(){
  vec2 px=1.0/uRenderSize;
  float h=heightAt(vUv);
  float hl=heightAt(vUv-vec2(px.x,0.));
  float hr=heightAt(vUv+vec2(px.x,0.));
  float hd=heightAt(vUv-vec2(0.,px.y));
  float hu=heightAt(vUv+vec2(0.,px.y));
  float hll=heightAt(vUv+px*vec2(-1.,-1.));
  float hlr=heightAt(vUv+px*vec2(1.,-1.));
  float hul=heightAt(vUv+px*vec2(-1.,1.));
  float hur=heightAt(vUv+px*vec2(1.,1.));

  float gx=(hr-hl)*2.0+(hlr-hll)+(hur-hul);
  float gy=(hu-hd)*2.0+(hul-hll)+(hur-hlr);
  vec3 N=normalize(vec3(-gx*uNormalStrength,-gy*uNormalStrength,uNormalZ));

  vec3 fieldScratchN=texture2D(uScratchNormal,vUv).rgb*2.0-1.0;
  float edgeAngle=1.22173;
  float edgeCos=cos(edgeAngle);
  float edgeSin=sin(edgeAngle);
  mat2 edgeRotation=mat2(edgeCos,-edgeSin,edgeSin,edgeCos);
  vec2 edgeScratchUv=fract(edgeRotation*(vUv-.5)+vec2(.83,.67));
  vec3 edgeScratchN=texture2D(uScratchNormal,edgeScratchUv).rgb*2.0-1.0;
  edgeScratchN.xy=mat2(edgeCos,edgeSin,-edgeSin,edgeCos)*edgeScratchN.xy;

  float scratchRimProfile=clamp(coinRimHeight(vUv)/max(uRimHeight,.0001),0.0,1.0);
  float scratchRimMask=smoothstep(.04,.62,scratchRimProfile);
  vec3 scratchN=normalize(mix(fieldScratchN,edgeScratchN,scratchRimMask));
  float scratchMix=clamp(uScratchStrength,0.0,1.0);
  scratchN=normalize(vec3(
    scratchN.xy*scratchMix*.58,
    mix(1.0,max(scratchN.z,.08),scratchMix)
  ));
  N=normalize(vec3(N.xy+scratchN.xy*N.z,N.z*scratchN.z));

  vec2 pv=(uPointer-.5)*vec2(.22,.30);
  vec3 V=normalize(vec3(pv,1.0));
  vec3 Lstatic=normalize(vec3(-.46,.58,.82));
  vec3 Lpointer=normalize(vec3(
    (uPointer.x-.5)*1.55,
    (uPointer.y-.5)*1.85,
    .88
  ));
  vec3 L=normalize(mix(Lstatic,Lpointer,.18+uPointerMix*uHover));
  vec3 Hf=normalize(L+V);
  float NoL=max(dot(N,L),0.0);
  float NoH=max(dot(N,Hf),0.0);
  float NoV=max(dot(N,V),0.0);
  vec3 F0=vec3(.72,.75,.79);
  float broad=pow(NoH,uBroadPower);
  float tight=pow(NoH,uTightPower);
  vec3 R=reflect(-V,N);

  float ang=radians(uStreakAngle);
  vec2 T=normalize(vec2(cos(ang),sin(ang)));
  vec2 B=vec2(-T.y,T.x);
  vec2 r2=normalize(R.xy+vec2(.00001));
  float along=dot(r2,T);
  float across=dot(r2,B);
  float anisoWidth=mix(2.0,10.0,uAnisotropy);
  float streakCore=exp(-pow(across*anisoWidth,2.0));
  float streakFalloff=pow(max(.0,1.0-abs(along)*.42),1.6);
  float movingPhase=
    uTime*(.03+uStreakMotion*uHover)+
    (uPointer.x-.5)*1.7*uHover+
    (uPointer.y-.5)*.9*uHover;
  float stripePattern=
    .5+.5*sin((dot(vUv,T)*uStreakSharpness*6.28318)+movingPhase*3.0);
  stripePattern=smoothstep(.18,.82,stripePattern);
  float anisotropicStreak=
    streakCore*mix(.58,1.0,stripePattern)*streakFalloff;

  float staticBand1=exp(-pow((R.x*.82+R.y*.30-.10)*3.0,2.0));
  float staticBand2=exp(-pow((R.x*.35-R.y*.92+.28)*5.2,2.0));
  float phase=uTime*(.035+uHoverMotion*uHover);
  float movingBand=exp(-pow(
    (R.x+sin(phase)*.24+(uPointer.x-.5)*.34*uHover)*4.4,
    2.0
  ));
  float softbox=.5+.5*clamp(R.y,-1.0,1.0);
  softbox=smoothstep(.05,.95,softbox);
  float fresnel=pow(1.0-NoV,4.0);
  float grain=sin(vUv.y*uTexSize.y*.72+sin(vUv.x*41.0)*1.8)*.5+.5;
  grain=(grain-.5)*.045;

  float avg=(hl+hr+hd+hu+hll+hlr+hul+hur)/8.0;
  float cavity=clamp((avg-h)*7.0,0.0,1.0);
  float crest=clamp((h-avg)*7.0,0.0,1.0);
  float slope=clamp(length(vec2(gx,gy))*5.0,0.0,1.0);
  vec2 ld=normalize(L.xy+vec2(.0001));
  float shadow=0.0;
  for(int i=1;i<=8;i++){
    float fi=float(i);
    float hh=heightAt(vUv+ld*px*fi*2.7);
    shadow+=smoothstep(h+fi*.014,h+fi*.014+.055,hh);
  }
  shadow=clamp(shadow/5.0,0.0,.68);

  vec3 metal=vec3(.31,.335,.37);
  vec3 col=metal*(uBaseLevel+.16*NoL);
  col+=F0*broad*uBroadIntensity;
  col+=F0*tight*uTightIntensity;
  col+=F0*staticBand1*uEnv1;
  col+=F0*staticBand2*uEnv2;
  col+=F0*anisotropicStreak*uStreakIntensity;
  col+=F0*movingBand*(.18+uMovingEnv*uHover);
  col+=F0*softbox*uSoftbox;
  col+=F0*fresnel*uFresnel;

  float rimProfile=clamp(coinRimHeight(vUv)/max(uRimHeight,.0001),0.0,1.0);
  float rimCrown=smoothstep(.82,.98,rimProfile);
  float rimShoulders=4.0*rimProfile*(1.0-rimProfile);
  col+=F0*rimCrown*(.07+.13*NoL+.14*broad);
  col+=F0*rimShoulders*(.10+.18*NoL+.24*tight);

  col*=1.0-cavity*uCavity;
  col*=1.0-shadow*uSelfShadow;
  col+=F0*crest*.10;
  col+=F0*slope*NoL*uSlopeLight;
  col+=grain*uGrain/.045;

  float topFill=1.0-smoothstep(.0,1.12,distance(vUv,vec2(.28,.90)));
  col+=vec3(.08,.085,.095)*topFill;
  float circularEdge=length(vUv-.5)*2.0;
  float edge=smoothstep(.86,1.02,circularEdge);
  col*=1.0-edge*.11;
  col=col/(col+vec3(.64));
  col=pow(col,vec3(.88));

  float authoredHeight=rawHeight(vUv);
  float heightSeparation=clamp(uReliefDepth*4.0,0.0,1.0);
  col*=mix(1.0,mix(.72,1.16,authoredHeight),heightSeparation);

  gl_FragColor=vec4(col,1.0);
}`;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Unable to load ${src}`));
      image.src = src;
    });
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'Metal coin shader compile failed');
    }
    return shader;
  }

  function createProgram(gl) {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Metal coin shader link failed');
    }
    return program;
  }

  function uploadTexture(gl, unit, image) {
    const texture = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image,
    );
    return texture;
  }

  function createRenderer(canvas, heightImage, scratchImage) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL is unavailable');

    const program = createProgram(gl);
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    uploadTexture(gl, gl.TEXTURE0, heightImage);
    uploadTexture(gl, gl.TEXTURE1, scratchImage);

    const uniform = name => gl.getUniformLocation(program, name);
    const U = {
      tex: uniform('uTex'),
      scratch: uniform('uScratchNormal'),
      texSize: uniform('uTexSize'),
      renderSize: uniform('uRenderSize'),
      pointer: uniform('uPointer'),
      time: uniform('uTime'),
      hover: uniform('uHover'),
    };
    const parameterUniforms = {};
    Object.keys(COIN_METAL_PARAMS).forEach(name => {
      if (['tiltStrength', 'shadowShift', 'hoverLift'].includes(name)) return;
      const shaderName = `u${name[0].toUpperCase()}${name.slice(1)}`;
      parameterUniforms[name] = uniform(shaderName);
    });

    gl.uniform1i(U.tex, 0);
    gl.uniform1i(U.scratch, 1);
    gl.uniform2f(U.texSize, heightImage.width, heightImage.height);
    Object.entries(parameterUniforms).forEach(([name, location]) => {
      if (location !== null) gl.uniform1f(location, COIN_METAL_PARAMS[name]);
    });

    function resize() {
      // The dashboard coin is displayed at half the Card Kit preview size.
      // Double its internal pixel density so relief detail remains comparable
      // without changing the coin's CSS dimensions or page layout.
      const dpr = Math.min((window.devicePixelRatio || 1) * 2, 3);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      return true;
    }

    function draw(pointer, hover) {
      resize();
      gl.useProgram(program);
      gl.uniform2f(U.renderSize, canvas.width, canvas.height);
      gl.uniform2f(U.pointer, pointer[0], pointer[1]);
      gl.uniform1f(U.time, performance.now() * 0.001);
      gl.uniform1f(U.hover, hover);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    return { draw };
  }

  const ACTION_SOUND_URL = 'assets/audio/coin-ping.wav';
  globalThis.TabOutAudio?.prepareBuffer(ACTION_SOUND_URL).catch(() => {});

  function primeActionSound() {
    globalThis.TabOutAudio?.prime();
  }

  function playActionSound({ playbackRate = 1, volume = 0.38, delay = 0 } = {}) {
    globalThis.TabOutAudio?.playBuffer(ACTION_SOUND_URL, { playbackRate, volume, delay });
  }

  Promise.all([
    loadImage(HEIGHT_FRONT),
    loadImage(HEIGHT_BACK),
    loadImage(SCRATCH_NORMAL),
  ]).then(([frontImage, backImage, scratchImage]) => {
    const renderer = {
      front: createRenderer(frontCanvas, frontImage, scratchImage),
      back: createRenderer(backCanvas, backImage, scratchImage),
    };

    let flipped = requestedSide === 'hidden';
    let flipping = false;
    let bouncing = false;
    let pointer = [0.5, 0.62];
    let hover = 0;
    let actionTimer = 0;
    let ambientHoldTimer = 0;
    let ambientPrimeTimer = 0;
    let ambientHoldSource = '';
    let ambientHoldTriggered = false;
    let ambientPointerId = null;
    let escapeKeyDown = false;
    let escapePressAt = 0;
    let escapePressTimer = 0;
    let shiftKeyDown = false;
    let shiftUsedAsModifier = false;
    let pressVisualTimer = 0;
    let suppressKeyboardClicksUntil = 0;
    const DOUBLE_PRESS_WINDOW = 300;
    const AMBIENT_PRIME_DELAY = 250;
    const AMBIENT_HOLD_DELAY = 900;
    const BASE_PRESS_SOUND = Object.freeze({ playbackRate: 1.65, volume: 0.12 });
    const SECOND_PRESS_SOUND = Object.freeze({ playbackRate: 1.67, volume: 0.06 });

    const visibleRenderer = () => renderer[flipped ? 'back' : 'front'];
    const drawVisible = () => visibleRenderer().draw(pointer, hover);
    const sideLabel = side => {
      if (globalThis.TabOutLanguage === 'zh') {
        return side === 'hidden'
          ? '「口袋」已隐藏；单击显示「口袋」。'
          : '「口袋」已显示；单击隐藏「口袋」。';
      }
      return side === 'hidden'
        ? 'Pocket hidden; click to show Pocket.'
        : 'Pocket visible; click to hide Pocket.';
    };

    syncRenderedMode = side => {
      flipped = side === 'hidden';
      coin.dataset.side = side;
      coin.classList.toggle('is-flipped', flipped);
      coin.setAttribute('aria-pressed', String(!flipped));
      coin.setAttribute('aria-label', sideLabel(side));
      drawVisible();
    };

    renderer.front.draw(pointer, 0);
    renderer.back.draw(pointer, 0);
    syncRenderedMode(requestedSide);
    coin.classList.add('is-ready');

    function finishFlip() {
      flipping = false;
      coin.classList.remove('is-flipping');
      clearTimeout(actionTimer);
    }

    function flip(withSound = true) {
      // A keyboard flip may reverse an in-progress CSS transition. Browsers
      // continue from the currently rendered transform, so rapid Shift taps
      // feel immediate instead of being dropped during the 720ms animation.
      if (bouncing) return false;
      flipping = true;
      flipped = !flipped;
      visibleRenderer().draw(pointer, hover);
      coin.classList.add('is-flipping');
      coin.classList.toggle('is-flipped', flipped);
      const visible = !flipped;
      coin.setAttribute('aria-pressed', String(visible));
      coin.dataset.side = visible ? 'visible' : 'hidden';
      coin.setAttribute('aria-label', sideLabel(visible ? 'visible' : 'hidden'));
      coin.dispatchEvent(new CustomEvent(DOM_EVENTS.POCKET_VISIBILITY_CHANGE, {
        bubbles: true,
        detail: { visible },
      }));
      if (withSound) playActionSound();
      clearTimeout(actionTimer);
      actionTimer = setTimeout(finishFlip, 780);
      return true;
    }

    function bounce() {
      if (flipping || bouncing) return false;
      bouncing = true;
      coin.classList.add('is-bouncing');
      clearTimeout(actionTimer);
      actionTimer = setTimeout(() => {
        bouncing = false;
        coin.classList.remove('is-bouncing');
      }, 430);
      return true;
    }

    function runCandidateRequest() {
      document.dispatchEvent(new CustomEvent(DOM_EVENTS.CANDIDATE_ACTION));
    }

    function showPressVisual() {
      window.clearTimeout(pressVisualTimer);
      coin.classList.remove('is-pressing');
      void coin.offsetWidth;
      coin.classList.add('is-pressing');
      pressVisualTimer = window.setTimeout(() => {
        coin.classList.remove('is-pressing');
        pressVisualTimer = 0;
      }, 150);
    }

    function emitAmbienceToggle(source) {
      traceAmbience('gesture:emit-toggle', { source });
      document.dispatchEvent(new CustomEvent(DOM_EVENTS.AMBIENCE_TOGGLE, {
        detail: { source },
      }));
    }

    function handleCoinPress(soundPlayed = false) {
      if (bouncing) return false;
      if (!soundPlayed) playActionSound(BASE_PRESS_SOUND);
      return flip(false);
    }

    function handleEscapePress() {
      const now = performance.now();
      const isSecondEscape = Boolean(
        escapePressAt && now - escapePressAt <= DOUBLE_PRESS_WINDOW
      );
      if (isSecondEscape) {
        window.clearTimeout(escapePressTimer);
        escapePressTimer = 0;
        escapePressAt = 0;
        runCandidateRequest();
        return;
      }
      escapePressAt = now;
      window.clearTimeout(escapePressTimer);
      escapePressTimer = window.setTimeout(() => {
        escapePressTimer = 0;
        escapePressAt = 0;
      }, DOUBLE_PRESS_WINDOW);
    }

    function beginAmbientHold(source) {
      if (flipping || bouncing) {
        traceAmbience('gesture:hold-rejected', { source, flipping, bouncing });
        return false;
      }
      traceAmbience('gesture:hold-begin', { source, delay: AMBIENT_HOLD_DELAY });
      window.clearTimeout(ambientHoldTimer);
      ambientHoldSource = source;
      ambientHoldTriggered = false;
      coin.classList.add('is-ambient-holding');
      showPressVisual();
      playActionSound(BASE_PRESS_SOUND);
      window.clearTimeout(ambientPrimeTimer);
      ambientPrimeTimer = window.setTimeout(() => {
        ambientPrimeTimer = 0;
        if (ambientHoldSource !== source) return;
        traceAmbience('gesture:emit-prime', { source });
        document.dispatchEvent(new CustomEvent(DOM_EVENTS.AMBIENCE_PRIME));
      }, AMBIENT_PRIME_DELAY);
      ambientHoldTimer = window.setTimeout(() => {
        ambientHoldTimer = 0;
        ambientHoldTriggered = true;
        traceAmbience('gesture:hold-complete', { source });
        coin.classList.remove('is-ambient-holding');
        playActionSound(SECOND_PRESS_SOUND);
        bounce();
        emitAmbienceToggle(source);
      }, AMBIENT_HOLD_DELAY);
      return true;
    }

    function endAmbientHold(source, completeClick) {
      if (ambientHoldSource !== source) return;
      traceAmbience('gesture:hold-end', { source, completeClick, triggered: ambientHoldTriggered });
      window.clearTimeout(ambientHoldTimer);
      window.clearTimeout(ambientPrimeTimer);
      ambientHoldTimer = 0;
      ambientPrimeTimer = 0;
      ambientHoldSource = '';
      coin.classList.remove('is-ambient-holding');
      const wasLongPress = ambientHoldTriggered;
      ambientHoldTriggered = false;
      if (completeClick && !wasLongPress) {
        handleCoinPress(true);
      }
    }

    coin.addEventListener('pointerenter', () => {
      hover = 1;
      drawVisible();
    });

    coin.addEventListener('pointermove', event => {
      const rect = coin.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      pointer = [x, 1 - y];
      if (flipping || bouncing) return;

      const nx = (x - 0.5) * 2;
      const ny = (y - 0.5) * 2;
      coin.style.setProperty('--tilt-x', `${-ny * COIN_METAL_PARAMS.tiltStrength}deg`);
      coin.style.setProperty('--tilt-y', `${nx * COIN_METAL_PARAMS.tiltStrength}deg`);
      coin.style.setProperty('--coin-shift-x', `${nx * 0.6}px`);
      coin.style.setProperty('--coin-lift', `${-COIN_METAL_PARAMS.hoverLift}px`);
      coin.style.setProperty('--coin-shadow-x', `${-nx * COIN_METAL_PARAMS.shadowShift * 0.72}px`);
      coin.style.setProperty('--coin-shadow-y', `${13 + ny * COIN_METAL_PARAMS.shadowShift * 0.34}px`);
      coin.style.setProperty('--coin-shadow-scale-x', String(0.985 - Math.abs(nx) * 0.07));
      coin.style.setProperty('--coin-shadow-scale-y', String(0.965 - Math.abs(ny) * 0.04));
      coin.style.setProperty('--coin-contact-x', `${-nx * COIN_METAL_PARAMS.shadowShift * 0.22}px`);
      coin.style.setProperty('--coin-contact-y', `${5 + ny * COIN_METAL_PARAMS.shadowShift * 0.12}px`);
      drawVisible();
    });

    coin.addEventListener('pointerleave', () => {
      hover = 0;
      pointer = [0.5, 0.62];
      coin.style.setProperty('--tilt-x', '0deg');
      coin.style.setProperty('--tilt-y', '0deg');
      coin.style.setProperty('--coin-shift-x', '0px');
      coin.style.setProperty('--coin-lift', '0px');
      coin.style.setProperty('--coin-shadow-x', '0px');
      coin.style.setProperty('--coin-shadow-y', '13px');
      coin.style.setProperty('--coin-shadow-scale-x', '.985');
      coin.style.setProperty('--coin-shadow-scale-y', '.965');
      coin.style.setProperty('--coin-contact-x', '0px');
      coin.style.setProperty('--coin-contact-y', '5px');
      drawVisible();
    });

    coin.addEventListener('pointerdown', primeActionSound, { passive: true });
    coin.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      traceAmbience('gesture:pointerdown', { pointerId: event.pointerId });
      ambientPointerId = event.pointerId;
      coin.setPointerCapture?.(event.pointerId);
      beginAmbientHold('coin');
    });

    coin.addEventListener('pointerup', event => {
      if (event.pointerId !== ambientPointerId) return;
      traceAmbience('gesture:pointerup', { pointerId: event.pointerId });
      ambientPointerId = null;
      endAmbientHold('coin', true);
    });

    coin.addEventListener('pointercancel', event => {
      if (event.pointerId !== ambientPointerId) return;
      ambientPointerId = null;
      endAmbientHold('coin', false);
    });

    coin.addEventListener('lostpointercapture', () => {
      if (ambientPointerId === null) return;
      ambientPointerId = null;
      endAmbientHold('coin', false);
    });

    coin.addEventListener('click', event => {
      if (event.detail === 0 && performance.now() < suppressKeyboardClicksUntil) {
        event.preventDefault();
        return;
      }
      // Non-pointer keyboard activation uses the same click resolver.
      if (event.detail === 0) {
        showPressVisual();
        handleCoinPress();
      }
    });

    coin.addEventListener('dblclick', event => {
      // Pointer-down handling above has already performed the action.
      event.preventDefault();
    });

    document.addEventListener('keydown', event => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement
        && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const isOtherControl = target instanceof HTMLElement
        && target !== coin
        && Boolean(target.closest('button, a, [role="button"]'));
      if (isEditable || isOtherControl) return;

      if (event.key === 'Shift') {
        if (event.repeat) return;
        primeActionSound();
        shiftKeyDown = true;
        shiftUsedAsModifier = event.ctrlKey || event.metaKey || event.altKey;
        return;
      }
      if (shiftKeyDown || event.shiftKey) shiftUsedAsModifier = true;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (!event.repeat) escapeKeyDown = true;
    });

    document.addEventListener('keyup', event => {
      if (event.key === 'Shift') {
        if (!shiftKeyDown) return;
        const shouldFlip = !shiftUsedAsModifier;
        shiftKeyDown = false;
        shiftUsedAsModifier = false;
        if (shouldFlip) {
          showPressVisual();
          handleCoinPress();
        }
        return;
      }
      if (event.key === 'Escape' && escapeKeyDown) {
        event.preventDefault();
        escapeKeyDown = false;
        handleEscapePress();
      }
    });

    window.addEventListener('blur', () => {
      escapeKeyDown = false;
      shiftKeyDown = false;
      shiftUsedAsModifier = false;
      suppressKeyboardClicksUntil = 0;
      if (ambientPointerId !== null) {
        ambientPointerId = null;
        endAmbientHold('coin', false);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      renderer.front.draw(pointer, flipped ? 0 : hover);
      renderer.back.draw(pointer, flipped ? hover : 0);
    });
    resizeObserver.observe(coin);
  }).catch(error => {
    console.warn('[tab-out] Could not initialize the metal coin:', error);
    coin.hidden = true;
  });
})();
