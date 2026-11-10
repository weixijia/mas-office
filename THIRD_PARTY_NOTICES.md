# Third-party notices

MAS Office is MIT-licensed. Some files adapt code from other open-source projects. Each such file names its source in a header comment, and each source is listed here with its license notice.

Format of each entry:

```
## <owner>/<repo> @ <commit>
- Files in MAS Office: <paths>
- Source files: <paths>
- License: <SPDX id>
<copyright line(s) and, for Apache-2.0, the NOTICE text>
```

## assafelovic/gpt-researcher @ 3582a6841fe7dc801e2a34e34ee408641aea9bce
- Files in MAS Office: `packages/node/src/verify/url-health.js` (`looksBlocked`, `looksLikeWordList`, `looksLikeUnextractedPdf`)
- Source files: `gpt_researcher/scraper/scraper.py` (lines 40–106)
- License: Apache-2.0
- Changes: ported from Python to JavaScript; four block-page markers added.
The repository has no NOTICE file, and its LICENSE names no copyright holder.

## Alibaba-NLP/DeepResearch @ f72f75d8c3eb842f2bbbab096a12206ff66e270f
- Files in MAS Office: `packages/node/src/verify/prompts.js` (`leadWriteupRules`, `finderRules`)
- Source files: `WebAgent/WebWeaver/prompt/write_prompt_multi_hop_2.py` (lines 96–107), `inference/prompt.py` (lines 37–50)
- License: Apache-2.0
- Changes: prompt wording adapted to our claim tag and source-card format.
The repository has no NOTICE file, and its LICENSE names no copyright holder.

## Ayanami0730/deep_research_bench @ f2735b5c3636759c22f9e936c0232de8bf545b67
- Files in MAS Office: `packages/node/src/verify/prompts.js` (`checkerRules`)
- Source files: `utils/validate.py` (lines 10–55)
- License: Apache-2.0 (per its LICENSE file)
- Changes: prompt wording adapted; a separate "partial" verdict added.
The repository has no NOTICE file, and its LICENSE names no copyright holder.

## Libr-AI/OpenFactVerification @ 6e1ee9e5159abe544c342689093afe12b908a419
- Files in MAS Office: `packages/node/src/verify/prompts.js` (`checkerRules`)
- Source files: `factcheck/utils/prompt/chatgpt_prompt.py` (lines 101–129)
- License: MIT
Copyright (c) 2024 LibrAI

## AgentSystemLabs/agent-office @ 852e2ab28c4f3f31bffdf4b20353bd119c9d3270
- Files in MAS Office: `panel/inbox.js` (`waited`, `waitKey`, `NextUp`, `edgeMarks`)
- Source files: `src/client/features/needsyou/logic.ts`, `src/client/nextup.ts`, `src/client/ui/compass.ts`
- License: MIT
Copyright (c) 2026 AgentSystemLabs

## paperclipai/paperclip @ b8e02fc2b418a9104612fa731f7afde7afcce6b5
- Files in MAS Office: `panel/inbox.js` (`compareRequests`)
- Source files: `ui/src/lib/blockedInbox.ts` (`compareBlockedAttention`)
- License: MIT
Copyright (c) 2025 Paperclip AI

## KbWen/agent-virtual-office @ 48e0e23da55cdf7b083afdee468d21f16cdd02b9
- Files in MAS Office: `panel/inbox.js` (`shouldNotify`), `panel/app.js` (`notifyTick`)
- Source files: `src/inference/desktopNotifier.js`
- License: MIT
Copyright (c) 2026 KbWen
