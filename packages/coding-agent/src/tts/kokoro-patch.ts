import * as fsp from "node:fs/promises";

import { resolveRuntimeModule } from "@oh-my-pi/pi-utils";

import { KOKORO_PACKAGE, KOKORO_VERSION } from "./runtime";

/**
 * kokoro-js ships every voice pack — including the `pf_*`/`pm_*` Portuguese
 * voices — but its Node bundle only lists the English voices in its validation
 * table and phonemizes every language as English: the `phonemizer` WASM it
 * depends on carries espeak-ng voice data for English voices only.
 *
 * `patchKokoroPortugueseVoices` widens the side-installed `dist/kokoro.cjs`
 * in place so `p`-prefixed voices validate and phonemize through a native
 * `espeak-ng` binary instead of that WASM. It is applied after every
 * (re)install of the runtime, is idempotent, and is all-or-nothing: anchors
 * are exact substrings of the kokoro-js dist bundle, so a version bump that
 * reshapes them fails loudly here rather than leaving a half-patched runtime.
 *
 * The espeak-ng output is Unicode-NFD normalized because espeak emits
 * precomposed nasal vowels (`ũ`) while the Kokoro tokenizer vocabulary only
 * contains the base vowels plus the combining tilde.
 */

/** Marker present in a bundle we have already patched. */
const PATCH_MARKER = "ompEspeakPT";

/**
 * Native espeak-ng phonemizer prepended to the bundle. Joins espeak's
 * per-utterance lines the same way the WASM path joins its array result.
 */
const ESPEAK_HELPER =
	"const ompEspeakPT=t=>{const{promise:n,resolve:ok,reject:l}=Promise.withResolvers();" +
	'try{require("child_process").execFile("espeak-ng",["-v","pt-br","-q","--ipa",t],{maxBuffer:1048576},' +
	'(r,e)=>{if(r)l(r.code==="ENOENT"?new Error("espeak-ng not found on PATH; install it (e.g. brew install espeak-ng) to synthesize Portuguese voices"):r);' +
	'else ok(e.normalize("NFD").split("\\n").filter(o=>o.length>0).join(" "))})}catch(r){l(r)}return n};';

/** Exact-substring rewrites applied to the kokoro-js dist bundle. */
const KOKORO_PATCHES: readonly { anchor: string; replacement: string }[] = [
	{
		// Inject the native espeak-ng phonemizer helper.
		anchor: '"use strict";var e=require("@huggingface/transformers")',
		replacement: `"use strict";${ESPEAK_HELPER}var e=require("@huggingface/transformers")`,
	},
	{
		// Register the Portuguese voices in the bundle's voice table.
		anchor:
			'bm_fable:{name:"Fable",language:"en-gb",gender:"Male",traits:"🚹",targetQuality:"B",overallGrade:"C"}});',
		replacement:
			'bm_fable:{name:"Fable",language:"en-gb",gender:"Male",traits:"🚹",targetQuality:"B",overallGrade:"C"},' +
			'pf_dora:{name:"Dora",language:"pt-br",gender:"Female",targetQuality:"B",overallGrade:"C"},' +
			'pm_alex:{name:"Alex",language:"pt-br",gender:"Male",targetQuality:"B",overallGrade:"C"},' +
			'pm_santa:{name:"Santa",language:"pt-br",gender:"Male",targetQuality:"C",overallGrade:"D"}});',
	},
	{
		// Give `p`-prefixed voices their own language identifier.
		anchor: 'c="a"===t?"en-us":"en",',
		replacement: 'c="p"===t?"pt-br":"a"===t?"en-us":"en",',
	},
	{
		// Route Portuguese segments to espeak-ng; English keeps the WASM path.
		anchor: 'e?t:(await a.phonemize(t,c)).join(" ")',
		replacement: 'e?t:("pt-br"===c?await ompEspeakPT(t):(await a.phonemize(t,c)).join(" "))',
	},
	{
		// Skip the English-only phoneme fixups (r→ɹ, x→k, …) for Portuguese;
		// keep only the mappings every language needs to stay in vocabulary.
		anchor: 'let u=g.replace(/kəkˈoːɹoʊ/g,"kˈoʊkəɹoʊ")',
		replacement:
			'let u="p"===t?g.replace(/ʲ/g,"j").replace(/ɬ/g,"l").replace(/ɫ/g,"l").replace(/[‿ ​]/g,""):g.replace(/kəkˈoːɹoʊ/g,"kˈoʊkəɹoʊ")',
	},
];

/**
 * Patch the kokoro-js dist bundle inside an installed TTS runtime so the
 * Portuguese voices validate and phonemize natively. No-op when the bundle is
 * already patched; throws when an anchor no longer matches the pinned
 * kokoro-js version.
 */
export async function patchKokoroPortugueseVoices(nodeModules: string): Promise<void> {
	const entry = resolveRuntimeModule(nodeModules, KOKORO_PACKAGE);
	if (!entry || !entry.endsWith("kokoro.cjs")) {
		throw new Error(`Unable to resolve ${KOKORO_PACKAGE} dist bundle in runtime at ${nodeModules}`);
	}
	const source = await fsp.readFile(entry, "utf8");
	if (source.includes(PATCH_MARKER)) return;
	let patched = source;
	for (const { anchor, replacement } of KOKORO_PATCHES) {
		const hits = patched.split(anchor).length - 1;
		if (hits !== 1) {
			throw new Error(
				`kokoro-js@${KOKORO_VERSION} patch anchor matched ${hits} times (expected 1); ` +
					`the dist bundle layout changed — update the anchors in tts/kokoro-patch.ts`,
			);
		}
		patched = patched.replace(anchor, replacement);
	}
	await fsp.writeFile(entry, patched);
}
