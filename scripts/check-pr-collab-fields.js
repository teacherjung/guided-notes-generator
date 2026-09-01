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
// ⚠️ 本專案（guided-notes-generator）的分工與 webapp／影片線不同：**Grok 實作、Codex 複審、Claude 最終掃描**，
//    所以角色表多一個 Grok。改這份清單＝改這道閘認得誰，PR 模板的填寫說明要同步。
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
 * 把欄位值正規化成**剛好一個**角色；看不出來或不只一個就回 `null`。
 *
 * ⚠️ 這裡刻意**不用 `includes`**（Codex #379 r1 High①）：`NotClaude` 含有 `Claude`、
 *    `Claude and Codex` 也含有 `Claude`——用 substring 判斷等於把 fail-open 寫進閘裡。
 *    先剝掉 markdown 粗體、反引號、括號註記與空白，再要求**全等**於某一個角色。
 *
 * @param {string} raw @returns {string | null}
 */
export function canonicalRole(raw) {
  // ⚠️ **正規化要做在最前面、只做一次**（Codex #379 r3 Medium）：
  //    r2 版只把外層正規化、括號內的檢查用原字串，於是 `Claude（Ｃｏｄｅｘ）`（全形）與
  //    `Claude（Co\u200bdex）`（零寬）都溜過去——括號被整段剝掉，剩下乾淨的 `Claude`。
  //    根因是「同一個字串有兩種形式在流動」。**之後所有判斷都只看正規化後的字串**。
  const bare = probeNormalize(String(raw || ''))
    .replace(/[`*_~]/g, '');                    // markdown 裝飾
  // ⚠️ **混用文字系統＝看不出是誰，fail-closed**（Codex #379 r4 Medium）：
  //    西里爾 `С`（U+0421）跟拉丁 `C` 在螢幕上長一樣，正規化折不掉——那是**不同的字母**。
  //    角色名全是拉丁字母；欄位裡出現「拉丁以外的字母混在拉丁詞裡」沒有任何正當理由，
  //    整欄直接判「看不出是誰」。不做 confusable 對照表（表列不完，同型病第四次）。
  if (/\p{Script=Latin}/u.test(bare)) {
    for (const ch of bare) {
      if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch) && !/\p{Script=Han}/u.test(ch)) return null;
    }
  }
  // **括號裡若藏著第二個角色就不算單一角色**（Codex #379 r2 Medium①）：
  //   「Claude（Codex）」剝掉括號會變成乾淨的 `Claude`，與「獨立審查者：Codex」搭配就整份通過——
  //   但那個欄位實際上提到了兩個角色，語意上正是「看不出是誰」。
  for (const inner of bare.match(/\([^)]*\)/g) || []) {
    // bare 已經過 probeNormalize——括號內的藏字元在這之前就被折掉了（r4 的四個重現都在這裡歸位）
    if (ROLES.some((r) => new RegExp(r, 'i').test(inner))) return null;
  }
  const t = bare
    .replace(/\([^)]*\)/g, '')                 // 括號註記（「Claude（已看過）」；NFKC 後全形括號已折成半形）
    .replace(/\s+/g, '')                        // 空白
    .trim();
  if (!t) return null;
  const hit = ROLES.filter((r) => r.toLowerCase() === t.toLowerCase());
  return hit.length === 1 ? hit[0] : null;      // 不只一個或零個 → 看不出來
}

/**
 * 檢查一份 PR 說明。回傳問題清單（空陣列＝通過）。
 * @param {string} body @returns {string[]}
 */
export function problemsOf(body) {
  /** @type {string[]} */ const problems = [];
  /** @type {Record<string,string>} */ const got = {};
  for (const f of REQUIRED_FIELDS) {
    const v = fieldValue(body, f);
    got[f] = v;
    if (!v) problems.push(`缺「${f}」`);
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
      problems.push(`「${label}」寫成「${raw}」，必須剛好是 ${ROLES.join('／')} 的其中一個`
        + '（不接受加註、多人並列、或看不出是誰的寫法）');
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
    + '\n\n請照 .github/pull_request_template.md 補齊再合併（規則見 AGENTS.md「審查與合併」節）。');
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
