import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	MarkdownView,
	ItemView,
	WorkspaceLeaf,
} from "obsidian";
import Anthropic from "@anthropic-ai/sdk";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface VaultWeaverSettings {
	anthropicApiKey: string;
	model: "claude-haiku-4-5-20251001" | "claude-sonnet-4-6" | "claude-opus-4-6";
	maxNotesPerAnalysis: number;
	autoSuggestOnOpen: boolean;
	analysisDepth: "quick" | "standard" | "deep";
}

const DEFAULT_SETTINGS: VaultWeaverSettings = {
	anthropicApiKey: "",
	model: "claude-haiku-4-5-20251001",
	maxNotesPerAnalysis: 200,
	autoSuggestOnOpen: false,
	analysisDepth: "standard",
};

interface BacklinkSuggestion {
	sourceNote: string;
	targetNote: string;
	reason: string;
	confidence: "high" | "medium" | "low";
	suggestedAnchorText: string;
}

interface OrphanNote {
	noteName: string;
	topicSummary: string;
	suggestedConnections: string[];
}

interface DuplicateGroup {
	notes: string[];
	similarity: string;
	mergeRecommendation: string;
}

interface KnowledgeGap {
	topic: string;
	rationale: string;
	suggestedTitle: string;
}

interface AnalysisResult {
	backlinkSuggestions: BacklinkSuggestion[];
	orphanedNotes: OrphanNote[];
	duplicateGroups: DuplicateGroup[];
	knowledgeGaps: KnowledgeGap[];
	summary: string;
	notesAnalyzed: number;
	timestamp: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Vault Scanner
// ────────────────────────────────────────────────────────────────────────────

interface NoteMetadata {
	name: string;
	path: string;
	incomingLinks: string[];
	outgoingLinks: string[];
	tags: string[];
	wordCount: number;
	firstParagraph: string;
}

async function scanVault(app: App, maxNotes: number): Promise<NoteMetadata[]> {
	const files = app.vault.getMarkdownFiles().slice(0, maxNotes);
	const metadataCache = app.metadataCache;
	const notes: NoteMetadata[] = [];

	for (const file of files) {
		const cache = metadataCache.getFileCache(file);
		const content = await app.vault.read(file);
		const lines = content.split("\n");

		// First meaningful paragraph (skip frontmatter + blank lines)
		let firstParagraph = "";
		let inFrontmatter = false;
		let frontmatterDone = false;
		for (const line of lines) {
			if (line.trim() === "---" && !frontmatterDone) {
				inFrontmatter = !inFrontmatter;
				if (!inFrontmatter) frontmatterDone = true;
				continue;
			}
			if (!inFrontmatter && line.trim().length > 40 && !line.startsWith("#")) {
				firstParagraph = line.trim().slice(0, 200);
				break;
			}
		}

		// Outgoing links from cache
		const outgoing: string[] = [];
		if (cache?.links) {
			for (const link of cache.links) {
				outgoing.push(link.link);
			}
		}

		// Tags
		const tags: string[] = [];
		if (cache?.tags) {
			for (const tag of cache.tags) {
				tags.push(tag.tag);
			}
		}
		if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) tags.push(...fmTags);
			else if (typeof fmTags === "string") tags.push(fmTags);
		}

		// Word count
		const wordCount = content.replace(/[^a-zA-Z\s]/g, " ").split(/\s+/).filter(Boolean).length;

		notes.push({
			name: file.basename,
			path: file.path,
			incomingLinks: [], // filled below
			outgoingLinks: [...new Set(outgoing)],
			tags: [...new Set(tags)],
			wordCount,
			firstParagraph,
		});
	}

	// Build reverse link index (incoming links)
	const linkMap: Record<string, string[]> = {};
	for (const note of notes) {
		for (const link of note.outgoingLinks) {
			if (!linkMap[link]) linkMap[link] = [];
			linkMap[link].push(note.name);
		}
	}
	for (const note of notes) {
		note.incomingLinks = linkMap[note.name] || [];
	}

	return notes;
}

// ────────────────────────────────────────────────────────────────────────────
// Claude Analysis
// ────────────────────────────────────────────────────────────────────────────

function buildAnalysisPrompt(notes: NoteMetadata[], depth: string): string {
	// Build a compact representation of the vault for the prompt
	const noteList = notes.map((n) => ({
		name: n.name,
		tags: n.tags.slice(0, 5),
		outLinks: n.outgoingLinks.slice(0, 10),
		inLinks: n.incomingLinks.slice(0, 5),
		words: n.wordCount,
		preview: n.firstParagraph.slice(0, 120),
	}));

	const orphanCandidates = notes
		.filter((n) => n.incomingLinks.length === 0 && n.wordCount > 50)
		.map((n) => n.name);

	const isolatedNotes = notes
		.filter((n) => n.incomingLinks.length === 0 && n.outgoingLinks.length === 0)
		.map((n) => n.name);

	const systemPrompt = `You are an expert knowledge management consultant analyzing an Obsidian vault.
Your goal is to help the user build a stronger, more interconnected knowledge graph.
Return ONLY valid JSON - no markdown, no code fences, no explanation before or after.`;

	const userPrompt = `Analyze this Obsidian vault with ${notes.length} notes.

VAULT DATA:
${JSON.stringify(noteList, null, 1)}

ORPHAN CANDIDATES (no incoming links): ${orphanCandidates.slice(0, 30).join(", ")}
FULLY ISOLATED (no links at all): ${isolatedNotes.slice(0, 20).join(", ")}

Analysis depth: ${depth}

Return a JSON object with EXACTLY this structure:
{
  "backlinkSuggestions": [
    {
      "sourceNote": "Note A",
      "targetNote": "Note B",
      "reason": "Brief explanation of why A should link to B",
      "confidence": "high|medium|low",
      "suggestedAnchorText": "the text that should become the [[link]]"
    }
  ],
  "orphanedNotes": [
    {
      "noteName": "Isolated Note",
      "topicSummary": "What this note appears to be about",
      "suggestedConnections": ["Note X", "Note Y"]
    }
  ],
  "duplicateGroups": [
    {
      "notes": ["Similar Note 1", "Similar Note 2"],
      "similarity": "Both appear to cover topic X",
      "mergeRecommendation": "Keep Note 1 as primary, merge content from Note 2"
    }
  ],
  "knowledgeGaps": [
    {
      "topic": "Missing topic based on existing notes",
      "rationale": "Why this gap exists",
      "suggestedTitle": "A Good Note Title for This Topic"
    }
  ],
  "summary": "2-3 sentence summary of the vault's knowledge graph health"
}

Rules:
- Suggest 5-15 backlinks (more for deep analysis)
- Identify 3-8 orphaned notes
- Find 0-3 duplicate groups (only if genuinely similar)
- Suggest 3-5 knowledge gaps
- Be specific about note names, use exact names from the vault data
- Focus on conceptual relationships, not just keyword matching`;

	return JSON.stringify({ system: systemPrompt, user: userPrompt });
}

async function analyzeWithClaude(
	apiKey: string,
	notes: NoteMetadata[],
	settings: VaultWeaverSettings
): Promise<AnalysisResult> {
	const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

	const promptData = JSON.parse(buildAnalysisPrompt(notes, settings.analysisDepth));

	const modelMap = {
		quick: "claude-haiku-4-5-20251001",
		standard: settings.model,
		deep: "claude-opus-4-6",
	};
	const model = modelMap[settings.analysisDepth];

	const response = await client.messages.create({
		model,
		max_tokens: 4096,
		system: promptData.system,
		messages: [{ role: "user", content: promptData.user }],
	});

	const rawText = response.content[0].type === "text" ? response.content[0].text : "{}";

	// Strip any accidental markdown code fences
	const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

	let parsed: Omit<AnalysisResult, "notesAnalyzed" | "timestamp" | "summary"> & {
		summary?: string;
	};

	try {
		parsed = JSON.parse(cleaned);
	} catch {
		throw new Error(
			"Claude returned invalid JSON. Try again or reduce the number of notes."
		);
	}

	return {
		backlinkSuggestions: parsed.backlinkSuggestions || [],
		orphanedNotes: parsed.orphanedNotes || [],
		duplicateGroups: parsed.duplicateGroups || [],
		knowledgeGaps: parsed.knowledgeGaps || [],
		summary: parsed.summary || "Analysis complete.",
		notesAnalyzed: notes.length,
		timestamp: Date.now(),
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Results View
// ────────────────────────────────────────────────────────────────────────────

const VIEW_TYPE_VAULT_WEAVER = "vault-weaver-results";

class VaultWeaverView extends ItemView {
	private result: AnalysisResult | null = null;

	constructor(leaf: WorkspaceLeaf, _plugin: VaultWeaverPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_VAULT_WEAVER;
	}

	getDisplayText() {
		return "Vault weaver";
	}

	getIcon() {
		return "git-merge";
	}

	setResult(result: AnalysisResult) {
		this.result = result;
		void this.render();
	}

	private createBadge(text: string, color: string): HTMLElement {
		const badge = document.createElement("span");
		badge.className = `vw-badge vw-badge-${color}`;
		badge.textContent = text;
		return badge;
	}

	render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("vault-weaver-container");

		if (!this.result) {
			container.createEl("div", {
				cls: "vw-empty",
				text: "Run an analysis to see suggestions here.",
			});
			return;
		}

		const r = this.result;

		// Header
		const header = container.createEl("div", { cls: "vw-header" });
		header.createEl("h2", { text: "Analysis results" });
		header.createEl("p", {
			cls: "vw-summary",
			text: r.summary,
		});

		const meta = header.createEl("div", { cls: "vw-meta" });
		meta.createEl("span", { text: `${r.notesAnalyzed} notes analyzed` });
		meta.createEl("span", { text: " · " });
		meta.createEl("span", { text: new Date(r.timestamp).toLocaleTimeString() });

		// ── Backlink Suggestions ──────────────────────────────────────────────
		if (r.backlinkSuggestions.length > 0) {
			const section = container.createEl("div", { cls: "vw-section" });
			const sectionHeader = section.createEl("div", { cls: "vw-section-header" });
			sectionHeader.createEl("h3", { text: "Missing backlinks" });
			sectionHeader.createEl("span", {
				cls: "vw-count",
				text: `${r.backlinkSuggestions.length}`,
			});

			const list = section.createEl("div", { cls: "vw-list" });
			for (const s of r.backlinkSuggestions) {
				const item = list.createEl("div", { cls: "vw-item" });
				const itemHeader = item.createEl("div", { cls: "vw-item-header" });

				const noteLink = itemHeader.createEl("span", { cls: "vw-note-link" });
				noteLink.textContent = s.sourceNote;
				noteLink.addEventListener("click", () => void this.openNote(s.sourceNote));

				itemHeader.createEl("span", { cls: "vw-arrow", text: " → " });

				const targetLink = itemHeader.createEl("span", {
					cls: "vw-note-link vw-target",
				});
				targetLink.textContent = `[[${s.targetNote}]]`;
				targetLink.addEventListener("click", () => void this.openNote(s.targetNote));

				itemHeader.appendChild(
					this.createBadge(s.confidence, s.confidence)
				);

				item.createEl("p", { cls: "vw-reason", text: s.reason });

				const anchor = item.createEl("div", { cls: "vw-anchor" });
				anchor.createEl("span", {
					cls: "vw-label",
					text: "Anchor text: ",
				});
				anchor.createEl("code", { text: `[[${s.targetNote}|${s.suggestedAnchorText}]]` });

				const actions = item.createEl("div", { cls: "vw-actions" });
				const insertBtn = actions.createEl("button", {
					cls: "vw-btn vw-btn-primary",
					text: "Open source note",
				});
				insertBtn.addEventListener("click", () => void this.openNote(s.sourceNote));
			}
		}

		// ── Orphaned Notes ────────────────────────────────────────────────────
		if (r.orphanedNotes.length > 0) {
			const section = container.createEl("div", { cls: "vw-section" });
			const sectionHeader = section.createEl("div", { cls: "vw-section-header" });
			sectionHeader.createEl("h3", { text: "Orphaned notes" });
			sectionHeader.createEl("span", {
				cls: "vw-count",
				text: `${r.orphanedNotes.length}`,
			});

			const list = section.createEl("div", { cls: "vw-list" });
			for (const o of r.orphanedNotes) {
				const item = list.createEl("div", { cls: "vw-item" });
				const noteLink = item.createEl("span", { cls: "vw-note-link" });
				noteLink.textContent = o.noteName;
				noteLink.addEventListener("click", () => void this.openNote(o.noteName));

				item.createEl("p", {
					cls: "vw-reason",
					text: o.topicSummary,
				});

				if (o.suggestedConnections.length > 0) {
					const connDiv = item.createEl("div", { cls: "vw-connections" });
					connDiv.createEl("span", {
						cls: "vw-label",
						text: "Connect to: ",
					});
					for (const conn of o.suggestedConnections) {
						const connLink = connDiv.createEl("span", {
							cls: "vw-note-link vw-conn-chip",
						});
						connLink.textContent = conn;
						connLink.addEventListener("click", () => void this.openNote(conn));
					}
				}
			}
		}

		// ── Duplicate Groups ──────────────────────────────────────────────────
		if (r.duplicateGroups.length > 0) {
			const section = container.createEl("div", { cls: "vw-section" });
			const sectionHeader = section.createEl("div", { cls: "vw-section-header" });
			sectionHeader.createEl("h3", { text: "Potential duplicates" });
			sectionHeader.createEl("span", {
				cls: "vw-count",
				text: `${r.duplicateGroups.length}`,
			});

			const list = section.createEl("div", { cls: "vw-list" });
			for (const d of r.duplicateGroups) {
				const item = list.createEl("div", { cls: "vw-item" });
				const noteRow = item.createEl("div", { cls: "vw-dupe-row" });
				for (const noteName of d.notes) {
					const chip = noteRow.createEl("span", { cls: "vw-note-link vw-chip" });
					chip.textContent = noteName;
					chip.addEventListener("click", () => void this.openNote(noteName));
				}

				item.createEl("p", {
					cls: "vw-reason",
					text: d.similarity,
				});
				item.createEl("p", {
					cls: "vw-recommendation",
					text: `Recommendation: ${d.mergeRecommendation}`,
				});
			}
		}

		// ── Knowledge Gaps ────────────────────────────────────────────────────
		if (r.knowledgeGaps.length > 0) {
			const section = container.createEl("div", { cls: "vw-section" });
			const sectionHeader = section.createEl("div", { cls: "vw-section-header" });
			sectionHeader.createEl("h3", { text: "Knowledge gaps" });
			sectionHeader.createEl("span", {
				cls: "vw-count",
				text: `${r.knowledgeGaps.length}`,
			});

			const list = section.createEl("div", { cls: "vw-list" });
			for (const g of r.knowledgeGaps) {
				const item = list.createEl("div", { cls: "vw-item" });
				item.createEl("strong", { text: g.suggestedTitle });
				item.createEl("p", { cls: "vw-reason", text: g.rationale });

				const createBtn = item.createEl("button", {
					cls: "vw-btn vw-btn-secondary",
					text: `Create "${g.suggestedTitle}"`,
				});
				createBtn.addEventListener("click", () => {
					void this.createNote(g.suggestedTitle).then(() => {
						new Notice(`Created: ${g.suggestedTitle}`);
					});
				});
			}
		}

		// ── Footer ────────────────────────────────────────────────────────────
		const footer = container.createEl("div", { cls: "vw-footer" });
		footer.createEl("span", { text: "Vault Weaver by Noah Albert" });
		const kofiLink = footer.createEl("a", {
			href: "https://ko-fi.com/noahalbert",
			text: "Support on ko-fi",
		});
		kofiLink.setAttr("target", "_blank");
	}

	private async openNote(name: string) {
		const files = this.app.vault.getMarkdownFiles();
		const file = files.find(
			(f) => f.basename.toLowerCase() === name.toLowerCase()
		);
		if (file) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		} else {
			new Notice(`Note not found: ${name}`);
		}
	}

	private async createNote(title: string) {
		const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-");
		const path = `${safeTitle}.md`;
		const exists = this.app.vault.getAbstractFileByPath(path);
		if (!exists) {
			await this.app.vault.create(path, `# ${title}\n\n`);
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Analysis Modal (progress)
// ────────────────────────────────────────────────────────────────────────────

class AnalysisProgressModal extends Modal {
	private statusEl: HTMLElement;
	public cancelled = false;

	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("vw-progress-modal");
		contentEl.createEl("h2", { text: "Analyzing vault..." });
		this.statusEl = contentEl.createEl("p", {
			text: "Scanning notes...",
			cls: "vw-status",
		});

		const cancelBtn = contentEl.createEl("button", {
			text: "Cancel",
			cls: "vw-btn vw-btn-secondary",
		});
		cancelBtn.addEventListener("click", () => {
			this.cancelled = true;
			this.close();
		});
	}

	setStatus(text: string) {
		if (this.statusEl) this.statusEl.textContent = text;
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Settings Tab
// ────────────────────────────────────────────────────────────────────────────

class VaultWeaverSettingTab extends PluginSettingTab {
	plugin: VaultWeaverPlugin;

	constructor(app: App, plugin: VaultWeaverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setHeading();

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Your API key from console.anthropic.com")
			.addText((text) =>
				text
					.setPlaceholder("Enter your API key")
					.setValue(this.plugin.settings.anthropicApiKey)
					.onChange(async (value) => {
						this.plugin.settings.anthropicApiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("AI model")
			.setDesc("Haiku is fastest and cheapest. Opus gives the best suggestions.")
			.addDropdown((drop) =>
				drop
					.addOption("claude-haiku-4-5-20251001", "Claude Haiku (fast, ~$0.001/analysis)")
					.addOption("claude-sonnet-4-6", "Claude Sonnet (balanced, ~$0.01/analysis)")
					.addOption("claude-opus-4-6", "Claude Opus (best quality, ~$0.05/analysis)")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model =
							value as VaultWeaverSettings["model"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max notes per analysis")
			.setDesc(
				"Limit how many notes are sent for analysis. Higher = better results but more cost."
			)
			.addSlider((slider) =>
				slider
					.setLimits(50, 500, 50)
					.setValue(this.plugin.settings.maxNotesPerAnalysis)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxNotesPerAnalysis = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Analysis depth")
			.setDesc("Quick uses claude haiku, deep uses claude opus.")
			.addDropdown((drop) =>
				drop
					.addOption("quick", "Quick (fewer suggestions, cheapest)")
					.addOption("standard", "Standard (your chosen model)")
					.addOption("deep", "Deep (most comprehensive)")
					.setValue(this.plugin.settings.analysisDepth)
					.onChange(async (value) => {
						this.plugin.settings.analysisDepth =
							value as VaultWeaverSettings["analysisDepth"];
						await this.plugin.saveSettings();
					})
			);

		const supportDiv = containerEl.createEl("div", { cls: "vw-support-banner" });
		supportDiv.createEl("p", {
			text: "This plugin is free and open source. If it saves you time, consider supporting:",
		});
		supportDiv.createEl("a", {
			href: "https://ko-fi.com/noahalbert",
			text: "Buy me a coffee on ko-fi",
		}).setAttr("target", "_blank");
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Main Plugin Class
// ────────────────────────────────────────────────────────────────────────────

export default class VaultWeaverPlugin extends Plugin {
	settings: VaultWeaverSettings = DEFAULT_SETTINGS;

	private getView(): VaultWeaverView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_WEAVER);
		if (leaves.length > 0 && leaves[0].view instanceof VaultWeaverView) {
			return leaves[0].view;
		}
		return null;
	}

	async onload() {
		await this.loadSettings();

		// Register the sidebar view
		this.registerView(
			VIEW_TYPE_VAULT_WEAVER,
			(leaf) => new VaultWeaverView(leaf, this)
		);

		// Ribbon icon
		this.addRibbonIcon("git-merge", "Open vault weaver", () => {
			void this.activateView();
		});

		// Command: Analyze Vault
		this.addCommand({
			id: "analyze-vault",
			name: "Analyze knowledge graph",
			callback: async () => {
				await this.runAnalysis();
			},
		});

		// Command: Find Orphaned Notes
		this.addCommand({
			id: "find-orphans",
			name: "Find orphaned notes",
			callback: async () => {
				await this.runAnalysis("orphans");
			},
		});

		// Command: Suggest Backlinks for Current Note
		this.addCommand({
			id: "suggest-backlinks-current",
			name: "Suggest backlinks for current note",
			editorCallback: async (_editor, view) => {
				if (!(view instanceof MarkdownView)) return;
				await this.runAnalysisForCurrentNote(view.file);
			},
		});

		// Settings tab
		this.addSettingTab(new VaultWeaverSettingTab(this.app, this));

		// Open view on startup if configured
		if (this.settings.autoSuggestOnOpen) {
			this.app.workspace.onLayoutReady(() => {
				void this.activateView();
			});
		}
	}

	onunload() {
		// Obsidian manages leaf cleanup automatically
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_VAULT_WEAVER)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) {
				new Notice("Could not open the panel.");
				return;
			}
			leaf = rightLeaf;
			await leaf.setViewState({ type: VIEW_TYPE_VAULT_WEAVER, active: true });
		}
		void workspace.revealLeaf(leaf);
	}

	async runAnalysis(_focus?: string) {
		if (!this.settings.anthropicApiKey) {
			new Notice(
				"Please add an API key in settings.",
				8000
			);
			return;
		}

		const modal = new AnalysisProgressModal(this.app);
		modal.open();

		try {
			modal.setStatus("Scanning vault notes...");
			const notes = await scanVault(this.app, this.settings.maxNotesPerAnalysis);

			if (modal.cancelled) return;
			modal.setStatus(`Analyzing ${notes.length} notes with Claude...`);

			const result = await analyzeWithClaude(
				this.settings.anthropicApiKey,
				notes,
				this.settings
			);

			if (modal.cancelled) return;
			modal.setStatus("Done!");
			modal.close();

			// Open view and display results
			await this.activateView();
			const view = this.getView();
			if (view) {
				view.setResult(result);
			}

			new Notice(
				`Analysis complete! Found ${result.backlinkSuggestions.length} backlink suggestions, ${result.orphanedNotes.length} orphaned notes.`,
				8000
			);
		} catch (err) {
			modal.close();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Vault Weaver error: ${msg}`, 10000);
			console.error("Vault Weaver:", err);
		}
	}

	async runAnalysisForCurrentNote(file: TFile | null) {
		if (!file) {
			new Notice("No active note.");
			return;
		}
		if (!this.settings.anthropicApiKey) {
			new Notice("Please add your API key in settings.");
			return;
		}

		new Notice(`Finding backlink suggestions for "${file.basename}"...`);

		try {
			// Get all notes for context, but prioritize the current note
			const allNotes = await scanVault(
				this.app,
				this.settings.maxNotesPerAnalysis
			);
			const currentNote = allNotes.find(
				(n) => n.name === file.basename
			);
			if (!currentNote) {
				new Notice("Could not read current note.");
				return;
			}

			// Pass current note context to Claude
			const limitedNotes = [
				currentNote,
				...allNotes
					.filter((n) => n.name !== file.basename)
					.slice(0, 80),
			];

			const result = await analyzeWithClaude(
				this.settings.anthropicApiKey,
				limitedNotes,
				this.settings
			);

			// Filter to suggestions relevant to current note
			result.backlinkSuggestions = result.backlinkSuggestions.filter(
				(s) =>
					s.sourceNote === file.basename ||
					s.targetNote === file.basename
			);

			await this.activateView();
			const view = this.getView();
			if (view) {
				view.setResult(result);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Error: ${msg}`, 8000);
		}
	}
}
