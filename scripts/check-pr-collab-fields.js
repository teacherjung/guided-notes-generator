#!/usr/bin/env node
// @ts-check
// 合併前的**協作欄位閘**（2026-08-02，文件體檢抓到）。
//
// ## 為什麼要有這支
//
// 「實作者不按自己的合併鍵」「高風險由對方複審」這些規則，在 git 與 GitHub 上**不留任何痕跡**：
// 40 支已合併 PR 的 `mergedBy` 全部是 teacherjung（Claude 與 Codex 都用同一個 token）、
// GitHub reviews 全部 0 筆。唯一還看得見分工的地方是 **PR 說明的欄位**——
// 而它靠記憶維持，**2026-08-02 實測已經斷了：#374／#375／#376 連續三支漏填**。
//
// 所以：模板（`.github/pull_request_template.md`）管「寫得出來」，這支腳本管「沒寫就合不了」。
// 兩者都沒有的話，唯一不變量（沒有任何一份產出由寫它的人放行）就只是一句話。
//
// 用法：node scripts/check-pr-collab-fields.js <PR 編號>
// 退出碼：0＝五欄齊全、且實作者 ≠ 獨立審查者
//         1＝缺欄位或實作者自審 → 停下來補齊，不要合併
//         2＝查不清楚（gh 失敗／回傳不是 JSON／形狀不符）→ **fail-closed**
//            「查不到」不等於「安全」——這是 check-pr-merge-gate.js 學到的教訓：
//            兩次堆疊事故畫面上都是 Merged＋CI 全綠、零錯誤訊息。

import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';

/**
 * ⚠️ **本檔 2026-09-01 自 teaching-videos repo 移植**（該檔又源自理財 webapp，2026-08-25 分家時搬過去）。
 *    本專案只改了兩處：**角色表加 Grok**、檔頭這段實況說明。其餘一字未動——
 *    底下每一條註解都對應理財 webapp 的一次真實事故，重寫會讓教訓失去出處。
 *    以下註解提到的考題檔
 *    （`test/…`）、其他 `scripts/check-*.js`（如 `check-pr-merge-gate.js`）與 PR 編號
 *    **都在 webapp、不在本 repo**——本 repo 沒有自動考題，
 *    所以**這支閘自己有在跑**（它是本 repo 唯一的 required check），但**沒有任何考題盯著它有沒有被改壞**，
 *    改它要格外小心。
 *    整支搬而不重寫的理由：底下每一條註解都對應一次實際被繞過的事故。
 *
 * **這支是合併程序的一道機械閘**——webapp 的 `test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 *
 * ⚠️ 別把清單手寫在考題裡（Codex #385 r9／r10）：手寫的漂過一次（加了第四道閘、
 * 文件仍寫三道，考題全綠看不見），改成從散文反查又被證明可繞（lazy continuation、
 * 檔名含數字、乾脆不寫進步驟）。**真相放在閘自己身上**，加一支就一定被數到。
 */
export const MERGE_GATE = { name: '協作欄位', why: 'PR 說明五欄齊全且實作者 ≠ 獨立審查者' };

/** 五個必填欄位。**這份清單是單一真相**——`.github/pull_request_template.md` 照它。 */
export const REQUIRED_FIELDS = [
  '實作者',
  '獨立審查者',
  '基準版本',
  '預計修改的共享檔案',
  '這支若完全失敗，最糟失去什麼',
];

/** 合法的角色名（實作者／審查者只能是這三個之一）。 */
// ⚠️ 角色表比 webapp 多一個 Grok（本專案把它列為合法角色）。分工現況見 CLAUDE.md「分工」節——
//    閘只守「實作者≠審查者」這條不變量、不記分工順序，分工變動不需要動這份清單（r2 之前這裡
//    抄了一份分工順序，分工一改就變成過期複本——會漂的不是規則，是複本）。
//    改這份清單＝改這道閘認得誰，PR 模板的填寫說明要同步。
export const ROLES = ['Claude', 'Codex', 'Grok', 'William'];

/**
 * 從 PR 說明裡抽出某一欄的值。
 *
 * ⚠️ **必須忽略 HTML 註解**：模板本身就把填寫說明放在 `<!-- -->` 裡，而那些說明裡也出現
 *    「實作者」「獨立審查者」等字。不剝註解的話，模板原封不動送出去也會通過＝這道閘等於沒有。
 *   （同型的病：#353 r1 的考題只掃文件關鍵字，被「把指令搬進 HTML 註解」直接繞過。）
 *
 * @param {string} body @param {string} field @returns {string}
 */
export function fieldValue(body, field) {
  const clean = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  // 形如：`- **實作者**：Claude` ／ `**實作者**: Claude` ／ `實作者：Claude`
  // ⚠️ 冒號後只准吃**水平空白**（`[^\\S\\n]`），不可用 `\\s`——`\\s` 會吃掉換行，
  //    於是「欄位留空」會抓到**下一行**的內容，空模板看起來像「每一欄都填了」。
  //    實測：本檔的考題抓到這個 bug——空模板只被判 2 條問題，而不是五欄皆缺。
  // ⚠️ **必須錨定在行首**（Codex #379 r2 High①）：不錨定的話 `- **非實作者**：Claude`
  //    也會命中——整份 PR 說明可以一個真欄位都沒有，卻被判「五欄齊全」＝機械閘 fail-open。
  //    允許的形狀：行首可有 `-`／`*` 項目符號與空白，欄名可被 `**`／`__` 包住，然後才是冒號。
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // 欄名含「，」等字元，仍統一跳脫
  //   ⚠️ 也接受有序清單 `1. **實作者**：`（Codex #379 r3 記錄項）——**噪音型誤擋會讓人乾脆繞過這道閘**，
  //   而「用 1. 而不是 -」顯然不是想規避什麼。引言符號 `>` 刻意**不接受**：那是引用範例，不該滿足閘。
  const re = new RegExp(`^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?[^\\S\\n]*[:：][^\\S\\n]*(.*)$`, 'm');
  const m = clean.match(re);
  return m ? m[1].trim().replace(/^\*+|\*+$/g, '').trim() : '';
}

/**
 * 同一欄位在說明裡出現幾次。
 * ⚠️ **每個必填欄位必須恰好出現一次**（本 repo r1 High②）：只讀第一個命中的話，
 *    「實作者：Claude／實作者：Codex／獨立審查者：Codex」會被判成 Claude 實作、Codex 審——
 *    自審藏在第二個欄位裡，機器只看見第一個。基準版本同理（兩個 SHA 各指一版＝歧義）。
 * @param {string} body @param {string} field @returns {number}
 */
export function fieldCount(body, field) {
  const clean = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?[^\\S\\n]*[:：]`, 'gm');
  return (clean.match(re) || []).length;
}

/**
 * 角色偵測用的**唯一**正規化管線（Codex #379 r4：括號掃描與最終比對必須看同一種形式）。
 *
 * 疊四層，各擋一類藏法（r3→r4 連兩輪的教訓＝少一層就有對應的繞法）：
 * ①NFKD——全形折半形、組合字拆開（`Ｃ`→`C`、`ó`→`o`＋重音）
 * ②去 `\p{M}`——拆開後的組合記號（U+0301 重音藏在字母上）
 * ③去 `\p{Default_Ignorable_Code_Point}`——U+034F、U+FE0F、U+2060 這類「預設不顯示」字元
 *   （⚠️ 比 `\p{Cf}` 大：U+034F 是 Mn、不在 Cf 裡——r4 就是這樣繞過 r3 的）
 * ④去 `\p{Cf}`——剩餘的格式控制字元
 *
 * @param {string} v @returns {string}
 */
export function probeNormalize(v) {
  return String(v || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Cf}/gu, '');
}

/**
 * 把欄位值正規化成**剛好一個**角色；對不上就回 `null`。
 *
 * ⚠️ **嚴格模式（r3 定案）**：剝掉 markdown 粗體／斜體裝飾與頭尾空白後，
 *    值必須**精確等於**某一個角色名（大小寫不計）。**不接受任何加註**——括號、斜線、
 *    描述文字，一律「看不出是誰」。
 *
 *    這是三輪審查打同一個洞之後的關門。演進全記在這裡，因為每一步都是實測繞過：
 *    r1 前：括號內掃角色 →「Co dex」一個空格穿過。
 *    r1：拔空白與 `-_.` 再掃 → `Co/dex`、全形斜線、`（Co）（dex）` 穿過（分隔符列舉不完）。
 *    r2：整欄拔掉非字母數字、數 distinct 角色 → `Co&#100;ex`、`Co<em>d</em>ex` 穿過——
 *        機器掃的是 markdown 原始碼，人看的是渲染結果，**兩層永遠可以不一樣**，
 *        而渲染語意（HTML entity、標籤、連結……）又是一個列舉不完的空間。
 *    r3 關門：**把加註空間整個關掉**。攻擊面是「加註裡可以藏東西」，那就不給加註。
 *    「Claude（已看過）」這類無害寫法一併被拒是刻意的代價——說明寫 PR 描述別處，
 *    錯誤訊息會講清楚怎麼改。模板填寫說明本來就寫「不接受加註」，閘從此真的執行它。
 *
 * @param {string} raw @returns {string | null}
 */
export function canonicalRole(raw) {
  const bare = probeNormalize(String(raw || ''))
    .replace(/[`*_~]/g, '')                     // markdown 粗體／斜體／刪除線裝飾
    .trim();
  const hit = ROLES.filter((r) => r.toLowerCase() === bare.toLowerCase());
  return hit.length === 1 ? hit[0] : null;
}

/**
 * 角色欄（實作者／獨立審查者）**不得有續行**（r4 關門）。
 *
 * r3 關掉了「同一行裡的加註」，r4 實測繞過：欄位本行填乾淨的 `Claude`，
 * **下一行**寫「（Codex 也有動）」——markdown 的清單續行（含 lazy continuation：
 * 縮排與頂格都算）會把它渲染進同一個清單項，人看到的是加註、機器只讀一行。
 * 規則：角色欄位行之後，直到空行／下一個清單項／標題之前，出現任何非空行＝擋。
 * 只管兩個角色欄——自由文字欄（如「最糟失去什麼」）寫多行是正常需求，攻擊面不在那裡
 * （自審藏在自由欄裡騙不過閘：閘比對的角色只從角色欄讀）。
 *
 * @param {string} body @returns {string[]}
 */
export function roleFieldContinuationProblems(body) {
  const clean = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  /** @type {string[]} */ const problems = [];
  for (const field of ['實作者', '獨立審查者']) {
    const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?[^\\S\\n]*[:：].*$`, 'm');
    const m = clean.match(re);
    if (!m || m.index === undefined) continue;
    const lines = clean.slice(m.index + m[0].length).split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) break;                                             // 空行＝清單項結束
      if (/^[^\S\n]*(?:[-*+]|\d+[.)])[^\S\n]+/.test(line)) break;     // 下一個清單項
      if (/^#{1,6}\s/.test(line)) break;                                  // 標題
      problems.push(`「${field}」欄位下面有續行「${line.trim().slice(0, 40)}」`
        + '——角色欄不得有任何續行（GitHub 會把它渲染進同一格，等於加註）。');
      break;
    }
  }
  return problems;
}

/**
 * 檢查一份 PR 說明。回傳問題清單（空陣列＝通過）。
 * @param {string} body @returns {string[]}
 */
export function problemsOf(body) {
  /** @type {string[]} */ const problems = [...roleFieldContinuationProblems(body)];
  /** @type {Record<string,string>} */ const got = {};
  for (const f of REQUIRED_FIELDS) {
    const n = fieldCount(body, f);
    if (n > 1) problems.push(`「${f}」出現 ${n} 次——每個必填欄位必須恰好一次，重複的欄位是歧義（自審可以藏在第二個裡）`);
    const v = fieldValue(body, f);
    got[f] = v;
    // ⚠️ 判空要用 probeNormalize 後的值（本 repo r1 Medium①）：單一個 U+200B 零寬空白
    //    trim() 不會除掉，「視覺上空白的欄位」就會過關——五欄齊全變成假宣稱。
    if (!probeNormalize(v).trim()) problems.push(`缺「${f}」`);
  }
  const implRaw = got['實作者'];
  const revRaw = got['獨立審查者'];
  const impl = canonicalRole(implRaw);
  const rev = canonicalRole(revRaw);

  // ⚠️ **角色必須正規化成剛好一個**（Codex #379 r1 High①）。
  //    第一版用 `includes(role)` 判斷「看不看得出角色」、用原字串比對是否同一人，於是實測：
  //      ・`實作者：Claude` ／ `獨立審查者：Claude（已看過）` → **通過**（字串不同）
  //      ・`實作者：NotClaude`                                → **通過**（含有 Claude）
  //      ・`實作者：Claude and Codex`                          → **通過**（含有 Claude）
  //    也就是「同一人自審」與「模糊多人」都繞得過——這道閘最核心的那一條回到靠人肉判讀。
  //    現在：剝掉格式與裝飾字之後**必須剛好命中一個角色**，然後比對正規化後的角色。
  for (const [label, raw, role] of [['實作者', implRaw, impl], ['獨立審查者', revRaw, rev]]) {
    if (raw && !role) {
      problems.push(`「${label}」寫成「${raw}」，必須**恰好等於** ${ROLES.join('／')} 的其中一個`
        + '——不接受任何加註（括號、描述文字都不行；說明請寫在 PR 描述其他地方）');
    }
  }
  // 核心那一條：實作者 ≠ 審查者。寫成同一個人＝違反唯一不變量，這道閘存在的全部理由。
  if (impl && rev && impl === rev) {
    problems.push(`實作者與獨立審查者都是「${impl}」——沒有任何一份產出可以由寫它的人放行`);
  }
  return problems;
}

/** @param {string} pr @returns {{ body: string, head: string }} */
function fetchPr(pr) {
  // ⚠️ **`env: gitEnv()` 不可省**（webapp AGENTS.md 鐵則 11；webapp #463 r1 High）：`gh` 會**自己再去 spawn git**
  //    ——實測 `env GIT_DIR=<不存在的路徑> gh pr view <N>` 回 `failed to run git: fatal: not a git repository`。
  //    繼承來的 GIT_DIR 指到另一個**有效** repo 時，這道閘會去讀**那個** repo 的 PR 與留言，
  //    而輸出看起來完全正常。行為題＝webapp 的 test/cross-pr-merge.test.js「四支會叫 gh 的閘」。
  const out = execFileSync('gh', ['pr', 'view', pr, '--json', 'body,headRefOid'], { encoding: 'utf8', env: gitEnv() });
  const parsed = JSON.parse(out);
  if (!parsed || typeof parsed.body !== 'string') throw new Error('gh 回傳的形狀不對');
  if (typeof parsed.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(parsed.headRefOid)) {
    throw new Error('gh 沒有回傳合法的 headRefOid');
  }
  return { body: parsed.body, head: parsed.headRefOid };
}

/**
 * 「基準版本」必須釘住**目前的 head**。
 *
 * ⚠️ 這一條在 #382 r4 之前是**擺著好看的**：模板明寫這個欄位是「審查要釘住的 commit，
 * 分支被推過之後審查結論就失效了」，但閘只檢查它非空——於是最常見的路徑
 * （**審完 A、作者再推 B**，完全不必是惡意）就讓「已審查」這件事變成過期的宣稱。
 * 這正是這道閘存在的理由的核心：**規則靠記憶維持，就會斷**。
 * @param {string} body @param {string} head @returns {string[]}
 */
export function staleBaseProblems(body, head) {
  const raw = fieldValue(body, '基準版本').replace(/[`*_\s]/g, '');
  // ⚠️ **抓「每一個」候選、而且要求全部都對**（Codex #382 r5 Medium）。
  //    第一版只抓第一段十六進位，於是：
  //      ・`d6c4fbd / f76d12b` 通過，反過來寫卻被拒——**結果取決於排列順序**
  //      ・`[d6c4fbd](…/commit/f76d12b)` 通過——顯示值更新、連結還指著舊 commit，
  //        這是**很常見的手滑**，正是這個欄位要防的東西
  //      ・40 碼後面再多一個十六進位字元也通過（那根本不是合法 SHA）
  //    判準改成：取**極大**的十六進位段（兩端都不是十六進位字元），長度 7–40 才算候選；
  //    候選一個都沒有＝紅，任何一個不是目前 head 的前綴＝紅。
  //    這與 #381 那支考題收斂到的判準是同一條：**「每一個都要對」，不是「有一個對」。**
  const runs = (raw.match(/[0-9a-fA-F]+/g) || []).filter((r) => r.length >= 7);
  const candidates = runs.filter((r) => r.length <= 40);
  if (!runs.length) {
    return [`「基準版本」讀不出 commit SHA（實得「${raw || '（空白）'}」）——至少要 7 碼十六進位`];
  }
  const bad = runs.filter((r) => r.length > 40 || !head.startsWith(r.toLowerCase()));
  if (bad.length) {
    return [`「基準版本」裡的 ${bad.map((b) => b.slice(0, 41)).join('、')} 不是這支 PR 目前的 head（${head.slice(0, 7)}）。\n`
      + '    分支被推過之後，先前的審查結論就不再適用——請把欄位（**含連結網址**）改成目前的 head 再合併。'];
  }
  if (!candidates.length) return [`「基準版本」讀不出合法的 commit SHA（實得「${raw}」）`];
  return [];
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-pr-collab-fields.js <PR 編號>');
    return 2;
  }
  /** @type {{ body: string, head: string }} */ let pull;
  try { pull = fetchPr(pr); }
  catch (e) {
    // fail-closed：查不到不等於安全
    console.error(`協作欄位閘 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;
  }
  const problems = [...problemsOf(pull.body), ...staleBaseProblems(pull.body, pull.head)];
  if (problems.length === 0) {
    console.log(`協作欄位閘 PR #${pr}：五欄齊全、實作者 ≠ 獨立審查者、基準版本＝目前 head。可繼續合併程序。`);
    return 0;
  }
  console.error(`協作欄位閘 PR #${pr}：**未通過**\n` + problems.map((p) => `  ・${p}`).join('\n')
    + '\n\n請照 .github/pull_request_template.md 補齊再合併（規則見 CLAUDE.md「分工」節）。');
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
