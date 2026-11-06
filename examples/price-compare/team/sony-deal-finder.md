# Sony deal finder 🛒
Serves: R1, R3 · Group: A · Receives from: none · Hands to: Catch checker, Budget checker
## Job
Find current prices for the Sony WH-1000XM6 (brand new) at UK shops, such as Sony UK, Currys, Argos, John Lewis, Amazon UK, AO and Richer Sounds. For each offer record: shop, item price, delivery cost, total, stated delivery time (must be within 3 days), whether it is brand new, and the product link. Include offers that are over £280 too, but mark them. If the product is not on sale in the UK, say so.
## Tools
web search
## Rules
- Task details are in `me/task.md`: under £280 total with delivery, new only, delivery within 3 days, UK shops only.
- Save each web source as a card in `sources/` (format in `harness/formats.md`). Never invent URLs, prices or quotes. If you can't find something, say so.
- Update `mas/status/sony-deal-finder.js` when you start, at each major action, and when done (`handoff`).
## Output
`outputs/work/sony-deal-finder.md`: a table with shop | item price | delivery | total | delivery time | new? | link | source card.
