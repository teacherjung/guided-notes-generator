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

/**
 * 行尾正規化：\r\n、裸 \r、U+2028、U+2029、U+0085 一律折成 \n（r5 High②）。
 * 不折的話：regex 的 m-flag 把 U+2028 當行尾（值抓得乾淨），split('\n') 卻不切它——
 * 兩套「行」的定義不一致，黏在 U+2028 後面的內容就從掃描縫隙溜過去。
 * 所有讀 body 的函式一律先過這裡，讓全檔只有一種「行」。
 * @param {string} s @returns {string}
 */
export function normalizeEols(s) {
  return String(s || '').replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n');
}

/**
 * 統一的前處理管線（r6 定案）：行尾正規化 → **遮蔽程式碼區塊與行內 code** → 剝 HTML 註解。
 *
 * 為什麼要遮蔽（Codex r6 兩條 High）：
 * ①五欄整份放進 fenced code block 或縮排四格——GitHub 渲染成**程式碼範例**，
 *   不是正式欄位，但逐行掃描照樣命中＝範例滿足了 required check。
 * ②行內 code 裡的 `<!-- -->` 在渲染上**看得見**，全域剝註解卻把它當隱形註解刪掉——
 *   「讀者看得到的加註」被機器當不存在。
 * 兩條的共同根因：剝註解／掃欄位發生在理解 markdown 語境之前。修法＝先把 code 語境
 * 整塊換成佔位字元（\x00），再做其他處理——佔位行不可能匹配欄位，也不可能是註解邊界。
 * 縮排 code 的判定從寬（行首 ≥4 空白即遮）：正常模板五欄零縮排，手動縮排四格填欄位
 * 會被形狀檢查退回並指路模板，是可接受的代價。
 *
 * @param {string} body @returns {string}
 */
/**
 * 縮排 code 行的**唯一**判定（r14）：行首 ≥4 空白或 tab、且含非空白內容。
 * r14 實測：cleanBody 與前導檢測各寫一份縮排判定，一份看行首、一份多要求緊接非空白，
 * 「tab＋空白＋內容」的行被 cleanBody 遮蔽、卻不被前導檢測禁——兩套判定的縫隙就是洞。
 * 同一個概念只准有一個定義（本檔的老教訓：兩套「行」的定義不一致時，r5 已經栽過一次）。
 * @param {string} line @returns {boolean}
 */
export function isIndentedCodeLine(line) {
  // CommonMark 的縮排定義是「展開 tab 後 ≥4 列」：tab 推進到下一個 4 的倍數邊界。
  // r15 抓到「1 空格＋tab」（＝1+3＝4 列）不被舊的字面判定（{4,}空白或行首 tab）涵蓋
  // ——當時靠其他前導檢查擋住、未成假綠，但「所有縮排形式由同一定義涵蓋」要成立，
  // 判定就要照 CommonMark 的列計算，不是照字元樣式列舉。
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col >= 4 && line.trim() !== '';
}

export function cleanBody(body) {
  const lines = normalizeEols(body).split('\n');
  let fence = '';   // 目前所在的圍欄記號（'`' 或 '~'），空字串＝不在圍欄裡
  const masked = lines.map((line) => {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (open && open[1][0] === fence) fence = '';
      return '\x00';
    }
    if (open) { fence = open[1][0]; return '\x00'; }
    if (isIndentedCodeLine(line)) return '\x00';             // 縮排 code（唯一判定）
    return line.replace(/`[^`\n]*`/g, '\x00');              // 行內 code span
  }).join('\n');
  // 註解**換佔位符，不刪除**（r10）：刪除會把註解兩側的文字拼接起來——
  // `-<!--x--> **實作者**：…` 刪完變成完美的 `- **實作者**：…`，檢查器看到合法清單、
  // GitHub 渲染的卻是段落（`-` 後緊接註解不是清單標記）。佔位符讓拼接不可能發生。
  // ⚠️ 註解用 \x01、code 遮蔽用 \x00，**兩種佔位不可混**：整行註解（模板頂部的合法
  // 用法）視同空行、可當前導略過；整行 code 遮蔽必須保持「非法前導」身分——
  // 第一版把兩者都當空行，fence 前導保護當場被自己的測試抓到拆掉。
  // ⚠️ 只有 **GFM 認定合法**的註解才換佔位（r11）：`<!--><details>-->` 這種偽註解
  //    GFM 不當註解、照渲染出其中的標籤，寬鬆 regex 卻把它整段當註解抹成空白——
  //    檢查文本刪掉了渲染文本裡真正生效的東西。GFM 的定義：內文不以 `>` 或 `->` 開頭、
  //    不含 `--`、不以 `-` 結尾。不合格的一律**保留原文**（fail-closed）：
  //    保留後 `<` 在欄位行是禁字、在前導區是非法前導，兩邊都擋。
  // 替換**保持行數**（r12）：跨行註解若縮成一個佔位，行號映射就斷了——
  // 後面的模稜檢測要拿「原始行」對照「清理行」，行數不一致整個對不上。
  const stripped = masked.replace(/<!--([\s\S]*?)-->/g, (whole, text) => {
    const legal = !/^(>|->)/.test(text) && !text.includes('--') && !/-$/.test(text);
    return legal ? whole.split('\n').map(() => '\x01').join('\n') : whole;
  });
  return stripped.split('\n').map((l) => (/^[\s\x01]*$/.test(l) ? '' : l)).join('\n');
}

/** 五個必填欄位。**這份清單是單一真相**——`.github/pull_request_template.md` 照它。 */
export const REQUIRED_FIELDS = [
  '實作者',
  '獨立審查者',
  '基準版本',
  '預計修改的共享檔案',
  '這支若完全失敗，最糟失去什麼',
];

/** 合法的角色名（實作者／審查者只能是本清單之一；數目刻意不寫進句子——寫死的數字自己會漂，r16 抓到一次）。 */
// ⚠️ 角色表比 webapp 多一個 Grok（本專案把它列為合法角色）。分工現況見 CLAUDE.md「分工」節——
//    閘只守「實作者≠審查者」這條不變量、不記分工順序，分工變動不需要動這份清單（r2 之前這裡
//    抄了一份分工順序，分工一改就變成過期複本——會漂的不是規則，是複本）。
//    改這份清單＝改這道閘認得誰，PR 模板的填寫說明要同步。
export const ROLES = ['Claude', 'Codex', 'Grok', 'William'];

/**
 * 欄位行核心 pattern 的**唯一**來源（r15）：fieldValue／fieldCount／形狀檢查原本
 * 各寫一份等價 regex——同一概念三份定義，就是 r5／r14 那種縫隙的溫床。
 * 這裡只定義「這一行提到某欄位」的寬鬆核心（bullet 可選、粗體可選）；
 * 「這一行是**合法**的欄位行」（精確「- 」前綴、行內禁字）是另一個概念，
 * 由形狀檢查額外把關，不屬於本工廠。
 * @param {string} field @returns {string} regex 源字串（不含 flags 與行尾捕獲）
 */
export function fieldLinePattern(field) {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?[^\\S\\n]*[:：]`;
}

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
  const clean = cleanBody(body);
  // 形如：`- **實作者**：Claude` ／ `**實作者**: Claude` ／ `實作者：Claude`
  // ⚠️ 冒號後只准吃**水平空白**（`[^\\S\\n]`），不可用 `\\s`——`\\s` 會吃掉換行，
  //    於是「欄位留空」會抓到**下一行**的內容，空模板看起來像「每一欄都填了」。
  //    實測：本檔的考題抓到這個 bug——空模板只被判 2 條問題，而不是五欄皆缺。
  // ⚠️ **必須錨定在行首**（Codex #379 r2 High①）：不錨定的話 `- **非實作者**：Claude`
  //    也會命中——整份 PR 說明可以一個真欄位都沒有，卻被判「五欄齊全」＝機械閘 fail-open。
  //    允許的形狀：行首可有 `-`／`*` 項目符號與空白，欄名可被 `**`／`__` 包住，然後才是冒號。
  const re = new RegExp(fieldLinePattern(field) + '[^\\S\\n]*(.*)$', 'm');
  const m = clean.match(re);
  // 只抽取與 trim（r16）：裝飾剝除統一由 canonicalRole 處理——
  // 這裡先剝首尾星號、那裡再剝一次，兩處各剝一半＝`*Claude` 這種**不成對**的
  // 星號被分兩站洗成乾淨的 Claude，顯示與判定不一致。
  return m ? m[1].trim() : '';
}

/**
 * 同一欄位在說明裡出現幾次。
 * ⚠️ **每個必填欄位必須恰好出現一次**（本 repo r1 High②）：只讀第一個命中的話，
 *    「實作者：Claude／實作者：Codex／獨立審查者：Codex」會被判成 Claude 實作、Codex 審——
 *    自審藏在第二個欄位裡，機器只看見第一個。基準版本同理（兩個 SHA 各指一版＝歧義）。
 * @param {string} body @param {string} field @returns {number}
 */
export function fieldCount(body, field) {
  const clean = cleanBody(body);
  const re = new RegExp(fieldLinePattern(field), 'gm');
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
  // 裝飾剝除的**唯一**站（r16）：只剝「成對、包住整個值」的粗斜體 delimiter
  // （`**Claude**`／`*Claude*`／`__Claude__`／`_Claude_`，可巢狀），由外而內逐層。
  // 不成對（`*Claude`）或嵌在字中（`Cl_aude`）的一律不剝——那些在渲染上就不是
  // 乾淨的角色名，剝了等於判定與顯示不一致（r16 實測三個假綠）。
  // 反引號、波浪號照舊不剝（r6）：值裡出現就不等於角色名。
  let bare = probeNormalize(String(raw || '')).trim();
  for (;;) {
    const m = bare.match(/^(\*\*|__|\*|_)(.+)\1$/);
    if (!m) break;
    bare = m[2].trim();
  }
  const hit = ROLES.filter((r) => r.toLowerCase() === bare.toLowerCase());
  return hit.length === 1 ? hit[0] : null;
}

/**
 * 協作欄位**五欄必須是連續五行、依模板順序**（r5 定案的白名單關門）。
 *
 * 沿革——這是「角色欄加註」這個洞的第六種修法，前五種全是黑名單、全被實測繞過：
 * 同行括號（r1 前）→ 分隔符拆字（r1）→ HTML entity／標籤（r2–r3）→ 清單續行（r4）→
 * 空行段落／巢狀子清單／U+2028 行分隔（r5）。markdown「什麼會被渲染進同一格」的語意
 * 是列舉不完的，判斷「什麼算續行」就是在重寫 renderer。
 * 白名單反過來：不判斷壞東西長什麼樣，要求好東西只有一種形狀——五欄連續五行、
 * 順序照模板、行間零容忍。任何黏進來的內容都會讓「下一行不是預期欄位」而報錯。
 * 第五欄（自由文字）之後的行不管：閘不從那裡讀任何判定，多行說明是正常需求。
 *
 * @param {string} body @returns {string[]}
 */
export function fieldBlockShapeProblems(body) {
  const clean = cleanBody(body);
  const lines = clean.split('\n');
  const fieldRe = (field) => new RegExp(fieldLinePattern(field));
  // **五欄必須在說明的最前面**（r7 定案的第二道白名單）。
  // r6–r7 的旁路（fenced code、跨行 code span、fence 長度細節、清單容器、raw HTML <pre>）
  // 有一個共同前提：五欄**前面**可以放任意內容——語境開啟符都是放在前面才生效的。
  // 與其把 GFM 的語境規則一條條搬進來（跨行 span、fence 長度、closing 尾端限制……
  // 每一條都是 spec 的真實細節，手寫模擬就是在重寫 renderer），直接拿掉那個前提：
  // 剝註解、遮蔽之後，第一個實質行只能是「## 協作欄位」標題或第一欄本身，
  // 五欄之前沒有任何餘地放語境開啟符。被遮蔽的行（\x00）也算不合法前導——
  // code 區塊擋在五欄前面同樣改變語境，一樣擋。
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;                                    // 空行可略過
    // 標題例外必須**整行精確匹配**（r8）：`##協作欄位 <details>` 既不是合法 ATX 標題
    // （# 後要有空白），行尾又帶著語境開啟符——只匹配前綴會把它當標題放過。
    if (/^#{1,6}[ \t]+協作欄位[ \t]*$/.test(l)) continue;
    firstIdx = i;
    break;
  }
  if (firstIdx === -1) return [];  // 整份空＝由「缺欄」檢查去報
  // **前導區禁止一切 code 類記號**（r12 立、r13 推廣並收緊）。
  // r12 實測：反引號吃掉原始註解的結尾，遮蔽後偽註解變合法；
  // r13 實測：縮排 code 與 ~~~ fence 同型——**任何**會被 code 階段遮蔽的形式
  // 都能改寫註解的邊界。與其列舉「哪些重疊算模稜」（列舉補不完），
  // 直接禁全類：前導區的四種合法狀態（空行／無 code 記號的整行合法註解／
  // 精確標題行／精確五欄行）沒有一種用得到 code 記號，單獨出現也沒有正當用法。
  // 範圍＝原始文本的第 0 行到第五欄行（所有替換保行數，行號可直接對照）。
  const rawLines = normalizeEols(body).split('\n');
  const prelude = rawLines.slice(0, firstIdx + REQUIRED_FIELDS.length);
  const codeMarked = prelude.find((l) =>
    l.includes('\u0060') || l.includes('~~~') || isIndentedCodeLine(l));
  if (codeMarked !== undefined) {
    return [`PR 說明開頭（協作欄位之前與五欄行）出現 code 類記號（反引號、~~~ 或 ≥4 格縮排）：`
      + `「${codeMarked.trim().slice(0, 40)}」——這些記號會改變前導區的渲染解讀，一律退回。`
      + '程式碼與範例請寫在五欄之後的說明區。'];
  }
  if (!fieldRe(REQUIRED_FIELDS[0]).test(lines[firstIdx])) {
    return [`協作欄位五欄必須放在 PR 說明的**最前面**（前面只准「## 協作欄位」標題與空行），`
      + `實際的第一行是「${lines[firstIdx].trim().slice(0, 40).replace(/\x00/g, '（程式碼區塊）')}」`
      + '——請照 .github/pull_request_template.md 的順序：五欄在最上、說明寫在五欄之後。'];
  }
  const idx = firstIdx;
  for (let k = 0; k < REQUIRED_FIELDS.length; k++) {
    const line = lines[idx + k];
    if (line === undefined || !fieldRe(REQUIRED_FIELDS[k]).test(line)) {
      return [`協作欄位五欄必須是**連續五行**、依模板順序。第 ${k + 1} 行應為「${REQUIRED_FIELDS[k]}」，`
        + `實得「${(line ?? '（沒有了）').trim().slice(0, 40)}」——`
        + '欄位行之間不得有任何續行、空行或其他內容（照 .github/pull_request_template.md 的形狀填）。'];
    }
    // 每一欄都必須以**模板的精確「- 」前綴**開頭（r8 要求清單項；r9 收緊為精確前綴）：
    // 寬鬆接受清單標記變體被實測打穿——十位數字的偽有序標記（GFM 上限九位）讓五行
    // 併回段落、跨行語法重新獲得吞行力；「- 」後多塞空白則渲染成清單內 code。
    // 模板就是「- 」，堅持精確前綴的誤擋成本趨近零，變體的驗證成本（縮排、位數、
    // 標記後空白、tab……）是又一個列舉不完的空間。
    if (!/^- \S/.test(line)) {
      return [`「${REQUIRED_FIELDS[k]}」那一行必須以「- 」開頭（一個連字號＋一個空白，`
        + '零縮排，照 .github/pull_request_template.md 原樣），且緊接欄名，不得多塞空白。'];
    }
    // 欄位行內禁止語境開啟符（r8 起；r9 補 `[`）：`<` 開 raw HTML、反引號開（跨行）
    // code span、`[` 開連結／圖片（`![…](…)` 的吞行力在 r9 被實測）、\x00 是遮蔽產物。
    // 值需要這些符號時，寫在五欄之後的說明區。
    const banned = line.match(/[<\`\[\x00\x01]/);
    if (banned) {
      return [`「${REQUIRED_FIELDS[k]}」那一行含「${banned[0] === '\x00' ? '程式碼片段' : banned[0] === '\x01' ? '行內註解' : banned[0]}」`
        + '——五欄行內不得出現 `<`、反引號、`[` 或程式碼片段（它們會改變後續欄位的渲染語境）。'
        + '需要這些符號的內容寫在五欄之後的說明區。'];
    }
  }
  return [];
}

/**
 * 檢查一份 PR 說明。回傳問題清單（空陣列＝通過）。
 * @param {string} body @returns {string[]}
 */
export function problemsOf(body) {
  /** @type {string[]} */ const problems = [...fieldBlockShapeProblems(body)];
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
