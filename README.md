# Vault Weaver

**AI-powered knowledge graph optimizer for Obsidian.**

Vault Weaver uses Claude AI to analyze your vault and surface the connections you've been missing. It finds notes that should link to each other, identifies orphaned notes floating alone with no context, detects near-duplicate content, and spots gaps in your knowledge map.

![Vault Weaver Screenshot](https://raw.githubusercontent.com/Android-Tipster/vault-weaver/main/assets/screenshot.png)

---

## What It Does

**Missing Backlinks** — Claude reads every note title, its existing links, and a preview of its content. It then suggests specific links you should add, with the exact anchor text to use and a reason why the connection matters.

**Orphaned Notes** — Finds notes with zero incoming links (the "lost" notes in your vault). For each one, Claude identifies what the note is about and suggests which existing notes should reference it.

**Duplicate Detector** — Flags notes that cover similar ground so you can consolidate them into a stronger, more authoritative note instead of fragmenting your thinking.

**Knowledge Gaps** — Based on the topics already in your vault, Claude identifies missing pieces: notes you haven't written yet that would complete your knowledge structure.

---

## Quick Start

1. Install the plugin (see below)
2. Go to **Settings > Vault Weaver**
3. Paste your Anthropic API key (get one free at [console.anthropic.com](https://console.anthropic.com))
4. Click the **Vault Weaver** icon in the left ribbon (looks like two branches merging)
5. Use the command palette (`Cmd/Ctrl+P`) and run **"Analyze Knowledge Graph"**

---

## Installation

### Manual (until community plugin review completes)

1. Download the latest release: [vault-weaver-1.0.0.zip](https://github.com/Android-Tipster/vault-weaver/releases/latest)
2. Extract to your vault's `.obsidian/plugins/vault-weaver/` folder
3. Enable the plugin in **Settings > Community Plugins**

### Via BRAT (Beta Reviewers Auto-update Tester)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Open BRAT settings and click **"Add Beta Plugin"**
3. Paste: `Android-Tipster/vault-weaver`
4. Enable Vault Weaver in **Settings > Community Plugins**

---

## Commands

| Command | What It Does |
|---------|-------------|
| **Analyze Knowledge Graph** | Full vault scan: backlinks, orphans, duplicates, gaps |
| **Find Orphaned Notes** | Focused scan for unconnected notes |
| **Suggest Backlinks for Current Note** | Quick analysis of just the note you have open |

---

## Settings

| Setting | Description |
|---------|-------------|
| **Anthropic API Key** | Your key from console.anthropic.com. Free tier is enough for most vaults. |
| **AI Model** | Haiku is cheapest (~$0.001/analysis). Opus gives the most nuanced suggestions. |
| **Max Notes Per Analysis** | Limit to control cost. 200 notes is a good default. |
| **Analysis Depth** | Quick (Haiku, fast), Standard (your chosen model), Deep (Opus, comprehensive) |

---

## Cost

Vault Weaver uses the Claude API which has a free tier. Typical analysis costs:

- **Haiku** (default): ~$0.001 per 200-note vault analysis
- **Sonnet**: ~$0.01 per analysis
- **Opus** (Deep mode): ~$0.05 per analysis

For most users, a month of daily analyses costs less than a cup of coffee.

---

## Privacy

Your notes are sent to Anthropic's API for analysis. Only note titles, existing links, tags, word counts, and the first 200 characters of each note are sent. The full content of your notes is never transmitted.

You can audit exactly what is sent in `main.ts` in the `scanVault` and `buildAnalysisPrompt` functions.

---

## Support

If Vault Weaver saves you time and makes your vault more useful, consider supporting development:

**[Buy me a coffee on Ko-fi](https://ko-fi.com/noahalbert)**

A Pro version with team vaults, automatic nightly analysis, and Notion/Logseq export is planned. Ko-fi supporters get early access.

---

## Roadmap

- [x] Backlink suggestions with anchor text
- [x] Orphaned note detection
- [x] Duplicate content groups
- [x] Knowledge gap identification
- [x] One-click note creation from gap suggestions
- [ ] Auto-insert accepted backlinks directly into note body
- [ ] Scheduled nightly analysis (background mode)
- [ ] Notion and Logseq export
- [ ] Vault health score + trend over time

---

## Contributing

PRs welcome. The plugin is MIT licensed.

```
git clone https://github.com/Android-Tipster/vault-weaver
cd vault-weaver
npm install
npm run dev
```

Copy the resulting `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/vault-weaver/` folder.

---

## License

MIT License. See [LICENSE](LICENSE).
