# 🎧 Headphone deal finder — Lead
- job: Combine the checked offers into a shortlist of the 2-3 best, with total prices and links
- serves: R4
- delegate: Approve web search automatically.
## 🛒 Sony deal finder
- serves: R1, R3
- job: Find UK shop prices, delivery costs and delivery times for the Sony WH-1000XM6
- output: A table of UK offers: shop, price, delivery cost, delivery time, condition and link, each citing its source card
- tools: web search
- group: A
- hands to: Catch checker
## 🔀 Similar-model finder
- serves: R1, R3
- job: Find UK offers on similar noise-cancelling headphones (e.g. Bose, Apple, Sennheiser) under £280 with delivery
- output: A table of UK offers on similar models under £280: model, shop, price, delivery, condition and link, each citing its source card
- tools: web search
- group: A
- hands to: Catch checker
## 🛡️ Catch checker
- serves: R2, R3
- job: Re-check every offer for refurbished stock, slow delivery and non-UK sellers
- output: A verdict per offer: new / refurbished, delivery days, UK seller, with the evidence for each
- backend: codex
- tools: web search
- reviewer of: Sony deal finder and Similar-model finder
- clean context: yes (sees only work files and source cards)
- review: up to 2 rounds, then ask me
- group: B
- hands to: Lead
## 🧮 Budget checker
- serves: R1
- job: Check that each offer's total including delivery (and any extra fees) stays under £280
- tools: web search
- group: B
- hands to: Lead
## Gates
- after A: Look at the offers before they are checked
## Budget
- up to 2 agents at once
