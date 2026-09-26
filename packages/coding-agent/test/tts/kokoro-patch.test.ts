import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { patchKokoroPortugueseVoices } from "@oh-my-pi/pi-coding-agent/tts/kokoro-patch";

/**
 * Synthetic kokoro-js dist bundle containing every patch anchor exactly once,
 * shaped like the minified 1.2.1 output around the patched regions.
 */
const FIXTURE = [
	'"use strict";var e=require("@huggingface/transformers"),a=require("phonemizer"),t=require("path"),r=require("fs/promises");',
	"function bulk(){return 1}",
	'const v=Object.freeze({af_heart:{name:"Heart",language:"en-us",gender:"Female",targetQuality:"A",overallGrade:"A"},',
	'bm_fable:{name:"Fable",language:"en-gb",gender:"Male",traits:"🚹",targetQuality:"B",overallGrade:"C"}});',
	'async function c(e,t="a",r=!0){const o=[];',
	'c="a"===t?"en-us":"en",g=(await Promise.all(o.map((async({match:e,text:t})=>e?t:(await a.phonemize(t,c)).join(" "))))).join("");',
	'let u=g.replace(/kəkˈoːɹoʊ/g,"kˈoʊkəɹoʊ").replace(/r/g,"ɹ");return u.trim()}',
	"exports.KokoroTTS=class{async generate(e,{voice:a}={}){const t=this._validate_voice(a),n=await c(e,t)}};",
].join("");

const VOICE_TABLE_ANCHOR =
	'bm_fable:{name:"Fable",language:"en-gb",gender:"Male",traits:"🚹",targetQuality:"B",overallGrade:"C"}});';

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function installFixture(modify?: (bundle: string) => string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-patch-"));
	tmpDirs.push(dir);
	const pkgDir = path.join(dir, "node_modules", "kokoro-js");
	fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: "kokoro-js", version: "1.2.1", main: "dist/kokoro.cjs" }),
	);
	fs.writeFileSync(path.join(pkgDir, "dist", "kokoro.cjs"), modify ? modify(FIXTURE) : FIXTURE);
	return path.join(dir, "node_modules");
}

function readBundle(nodeModules: string): string {
	return fs.readFileSync(path.join(nodeModules, "kokoro-js", "dist", "kokoro.cjs"), "utf8");
}

describe("patchKokoroPortugueseVoices", () => {
	test("wires Portuguese voices and native espeak-ng into the bundle", async () => {
		const nodeModules = installFixture();
		await patchKokoroPortugueseVoices(nodeModules);
		const patched = readBundle(nodeModules);
		expect(patched.includes("ompEspeakPT")).toBe(true);
		expect(patched.includes('pf_dora:{name:"Dora"')).toBe(true);
		expect(patched.includes('pm_alex:{name:"Alex"')).toBe(true);
		expect(patched.includes('pm_santa:{name:"Santa"')).toBe(true);
		expect(patched.includes('c="p"===t?"pt-br":"a"===t?"en-us":"en",')).toBe(true);
		expect(patched.includes('"pt-br"===c?await ompEspeakPT(t):(await a.phonemize(t,c)).join(" ")')).toBe(true);
		expect(patched.includes('let u="p"===t?g.replace(/ʲ/g,"j")')).toBe(true);
		// The English path through the WASM phonemizer stays intact.
		expect(patched.includes('(await a.phonemize(t,c)).join(" ")')).toBe(true);
	});

	test("is idempotent across repeated loads", async () => {
		const nodeModules = installFixture();
		await patchKokoroPortugueseVoices(nodeModules);
		const first = readBundle(nodeModules);
		await patchKokoroPortugueseVoices(nodeModules);
		expect(readBundle(nodeModules)).toBe(first);
	});

	test("fails loudly and leaves the bundle untouched when an anchor drifts", async () => {
		const nodeModules = installFixture(bundle => bundle.replace(VOICE_TABLE_ANCHOR, "bm_fable:{}});"));
		await expect(patchKokoroPortugueseVoices(nodeModules)).rejects.toThrow(/anchor matched 0 times/);
		// All-or-nothing: the earlier anchors must not have been written either.
		expect(readBundle(nodeModules)).not.toContain("ompEspeakPT");
	});
});
