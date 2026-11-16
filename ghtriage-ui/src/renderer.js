/* global triageApi */

const WORD_PREVIEW_LIMIT = 50;

const state = {
	filePath: null,
	rawYaml: '',
	items: [],
	filterType: 'all', // 'all' | 'pr' | 'issue'
	searchQuery: '',
	nextCustomLabelId: 1000,
};

// DOM Elements
const activeFileBadge = document.getElementById('active-file-badge');
const triageTbody = document.getElementById('triage-tbody');
const emptyState = document.getElementById('empty-state');
const scriptPreview = document.getElementById('script-preview');
const scriptSummaryMeta = document.getElementById('script-summary-meta');
const countAll = document.getElementById('count-all');
const countPr = document.getElementById('count-pr');
const countIssue = document.getElementById('count-issue');
const checkboxSelectAll = document.getElementById('checkbox-select-all');
const searchInput = document.getElementById('search-input');
const knownLabelsDatalist = document.getElementById('known-labels-datalist');
const toastContainer = document.getElementById('toast-container');

// Modal Elements
const yamlModalBackdrop = document.getElementById('yaml-modal-backdrop');
const yamlTextarea = document.getElementById('yaml-textarea');
const yamlModalError = document.getElementById('yaml-modal-error');

function showToast(message) {
	const toast = document.createElement('div');
	toast.className = 'toast';
	toast.textContent = message;
	toastContainer.appendChild(toast);
	setTimeout(() => {
		toast.remove();
	}, 2800);
}

/**
 * Splits a full description string at `wordLimit` words (default 200) while preserving
 * internal whitespace and line breaks.
 */
function splitWordsPreview(text, wordLimit = WORD_PREVIEW_LIMIT) {
	const fullText = String(text || '').trim();
	if (!fullText) {
		return {
			previewText: '',
			remainingText: '',
			fullText: '',
			isTruncated: false,
			totalWords: 0,
			hiddenWords: 0,
		};
	}

	const wordMatches = Array.from(fullText.matchAll(/\S+/g));
	const totalWords = wordMatches.length;

	if (totalWords <= wordLimit) {
		return {
			previewText: fullText,
			remainingText: '',
			fullText,
			isTruncated: false,
			totalWords,
			hiddenWords: 0,
		};
	}

	const boundaryMatch = wordMatches[wordLimit - 1];
	const cutIndex = boundaryMatch.index + boundaryMatch[0].length;
	return {
		previewText: fullText.slice(0, cutIndex),
		remainingText: fullText.slice(cutIndex),
		fullText,
		isTruncated: true,
		totalWords,
		hiddenWords: totalWords - wordLimit,
	};
}

function getFilteredItems() {
	const q = state.searchQuery.trim().toLowerCase();
	return state.items.filter((item) => {
		if (state.filterType !== 'all' && item.type !== state.filterType) {
			return false;
		}
		if (!q) return true;
		const haystack = [
			item.link,
			item.repo,
			item.number ? `#${item.number}` : '',
			...(item.shortDescription || []),
			item.description || '',
			...(item.currentLabels || []),
			...(item.labels || []).map((l) => `${l.name} ${l.action} ${l.reason}`),
		]
			.join(' ')
			.toLowerCase();
		return haystack.includes(q);
	});
}

function updateKnownLabelsDatalist() {
	const labelSet = new Set();
	for (const item of state.items) {
		for (const c of item.currentLabels || []) labelSet.add(c);
		for (const l of item.labels || []) {
			if (l.name) labelSet.add(l.name);
		}
	}
	knownLabelsDatalist.innerHTML = '';
	for (const lbl of Array.from(labelSet).sort()) {
		const opt = document.createElement('option');
		opt.value = lbl;
		knownLabelsDatalist.appendChild(opt);
	}
}

function updateCounts() {
	const total = state.items.length;
	const prs = state.items.filter((i) => i.type === 'pr').length;
	const issues = state.items.filter((i) => i.type === 'issue').length;
	countAll.textContent = String(total);
	countPr.textContent = String(prs);
	countIssue.textContent = String(issues);
}

async function refreshScriptPreview() {
	const script = await triageApi.generateScript(state.items);
	scriptPreview.textContent = script;

	const activeItemsCount = state.items.filter(
		(item) =>
			item.included &&
			(item.labels || []).some((l) => l.enabled && l.name && l.name.trim())
	).length;
	scriptSummaryMeta.textContent = `${activeItemsCount} gh command${activeItemsCount === 1 ? '' : 's'} ready`;
}

async function fetchMissingDescriptions() {
	for (const item of state.items) {
		if (item.description || item.descLoading || item.descFetchAttempted) {
			continue;
		}
		item.descLoading = true;
		item.descFetchAttempted = true;
		renderTable();

		const res = await triageApi.fetchGithubDescription({
			repo: item.repo,
			number: item.number,
			type: item.type,
			link: item.link,
		});
		item.descLoading = false;
		if (res && typeof res.body === 'string' && res.body.trim()) {
			item.description = res.body.trim();
			item.descError = null;
		} else {
			item.descError = (res && res.error) || 'No description available';
		}
		renderTable();
	}
}

function renderTable() {
	updateCounts();
	updateKnownLabelsDatalist();

	const visibleItems = getFilteredItems();
	triageTbody.innerHTML = '';

	if (visibleItems.length === 0) {
		emptyState.classList.remove('hidden');
	} else {
		emptyState.classList.add('hidden');
	}

	const allVisibleIncluded =
		visibleItems.length > 0 && visibleItems.every((i) => i.included);
	checkboxSelectAll.checked = allVisibleIncluded;

	for (const item of visibleItems) {
		const tr = document.createElement('tr');
		if (!item.included) {
			tr.classList.add('row-excluded');
		}

		// 1. Include checkbox column
		const tdCheck = document.createElement('td');
		tdCheck.className = 'td-check';
		const rowCheck = document.createElement('input');
		rowCheck.type = 'checkbox';
		rowCheck.checked = Boolean(item.included);
		rowCheck.title = 'Include this item in generated gh script';
		rowCheck.addEventListener('change', () => {
			item.included = rowCheck.checked;
			renderTable();
			refreshScriptPreview();
		});
		tdCheck.appendChild(rowCheck);
		tr.appendChild(tdCheck);

		// 2. Item link & badge column
		const tdItem = document.createElement('td');
		const linkBtn = document.createElement('button');
		linkBtn.type = 'button';
		linkBtn.className = `item-link-btn kind-${item.type}`;
		const badgeLabel = item.number
			? `${item.type.toUpperCase()} #${item.number}`
			: item.type.toUpperCase();
		linkBtn.textContent = `${badgeLabel} ↗`;
		linkBtn.title = `Open ${item.link} in browser`;
		linkBtn.addEventListener('click', () => {
			triageApi.openExternal(item.link);
		});
		tdItem.appendChild(linkBtn);

		if (item.repo) {
			const repoSpan = document.createElement('span');
			repoSpan.className = 'item-repo-sub';
			repoSpan.textContent = item.repo;
			tdItem.appendChild(repoSpan);
		}
		tr.appendChild(tdItem);

		// 3. Short Description column
		const tdDesc = document.createElement('td');
		if (item.shortDescription && item.shortDescription.length > 0) {
			const ul = document.createElement('ul');
			ul.className = 'desc-list';
			for (const line of item.shortDescription) {
				const li = document.createElement('li');
				li.textContent = line;
				ul.appendChild(li);
			}
			tdDesc.appendChild(ul);
		} else {
			const emptyDesc = document.createElement('span');
			emptyDesc.className = 'empty-pill-note';
			emptyDesc.textContent = 'No short description';
			tdDesc.appendChild(emptyDesc);
		}
		tr.appendChild(tdDesc);

		// 4. Full Description column
		const tdFullDesc = document.createElement('td');
		const fullDescWrap = document.createElement('div');
		fullDescWrap.className = 'full-desc-wrap';

		if (item.description && item.description.trim()) {
			const split = splitWordsPreview(item.description, WORD_PREVIEW_LIMIT);
			const bodyDiv = document.createElement('div');
			bodyDiv.className = 'full-desc-body';

			if (!split.isTruncated || item.descExpanded) {
				bodyDiv.textContent = split.fullText;
			} else {
				bodyDiv.textContent = split.previewText;
				const ellipsis = document.createElement('span');
				ellipsis.className = 'full-desc-ellipsis';
				ellipsis.textContent = ' …';
				bodyDiv.appendChild(ellipsis);
			}
			fullDescWrap.appendChild(bodyDiv);

			if (split.isTruncated) {
				const toggleBtn = document.createElement('button');
				toggleBtn.type = 'button';
				toggleBtn.className = 'btn-expand-desc';
				toggleBtn.textContent = item.descExpanded
					? `collapse`
					: `expand`;
				toggleBtn.addEventListener('click', () => {
					item.descExpanded = !item.descExpanded;
					renderTable();
				});
				fullDescWrap.appendChild(toggleBtn);
			}
		} else if (item.descLoading) {
			const loadingSpan = document.createElement('span');
			loadingSpan.className = 'empty-pill-note';
			loadingSpan.textContent = 'Fetching description from GitHub…';
			fullDescWrap.appendChild(loadingSpan);
		} else {
			const metaRow = document.createElement('div');
			metaRow.className = 'full-desc-meta';
			const emptyNote = document.createElement('span');
			emptyNote.className = 'empty-pill-note';
			emptyNote.textContent = item.descError ? 'Not in YAML' : 'No description';
			metaRow.appendChild(emptyNote);

			const retryBtn = document.createElement('button');
			retryBtn.type = 'button';
			retryBtn.className = 'btn-expand-desc';
			retryBtn.textContent = 'Fetch from GitHub';
			retryBtn.title = item.descError || 'Fetch description from linked GitHub item';
			retryBtn.addEventListener('click', async () => {
				item.descLoading = true;
				renderTable();
				const res = await triageApi.fetchGithubDescription({
					repo: item.repo,
					number: item.number,
					type: item.type,
					link: item.link,
				});
				item.descLoading = false;
				if (res && typeof res.body === 'string' && res.body.trim()) {
					item.description = res.body.trim();
					item.descError = null;
				} else {
					item.descError = (res && res.error) || 'Failed to fetch from GitHub';
					showToast(`GitHub fetch: ${item.descError}`);
				}
				renderTable();
			});
			metaRow.appendChild(retryBtn);
			fullDescWrap.appendChild(metaRow);
		}

		tdFullDesc.appendChild(fullDescWrap);
		tr.appendChild(tdFullDesc);

		// 5. Current Labels column (click a current label to stage REMOVE)
		const tdCurrent = document.createElement('td');
		const currentWrap = document.createElement('div');
		currentWrap.className = 'current-labels-wrap';

		if (item.currentLabels && item.currentLabels.length > 0) {
			for (const curLbl of item.currentLabels) {
				const pill = document.createElement('button');
				pill.type = 'button';
				pill.className = 'current-label-pill';
				const isRemoving = (item.labels || []).some(
					(l) => l.enabled && l.action === 'REMOVE' && l.name === curLbl
				);
				if (isRemoving) {
					pill.classList.add('already-removing');
				}
				pill.textContent = curLbl;
				pill.title = isRemoving
					? `"${curLbl}" is staged for removal (click to undo)`
					: `Click to propose removing "${curLbl}"`;
				pill.addEventListener('click', () => {
					const existing = (item.labels || []).find(
						(l) => l.name === curLbl && l.action === 'REMOVE'
					);
					if (existing) {
						existing.enabled = !existing.enabled;
					} else {
						item.labels.push({
							id: `lbl-custom-${state.nextCustomLabelId++}`,
							name: curLbl,
							action: 'REMOVE',
							reason: 'Removed during interactive triage',
							enabled: true,
						});
					}
					renderTable();
					refreshScriptPreview();
				});
				currentWrap.appendChild(pill);
			}
		} else {
			const noneNote = document.createElement('span');
			noneNote.className = 'empty-pill-note';
			noneNote.textContent = 'None';
			currentWrap.appendChild(noneNote);
		}
		tdCurrent.appendChild(currentWrap);
		tr.appendChild(tdCurrent);

		// 6. Proposed Label Changes column
		const tdProposed = document.createElement('td');
		const proposedList = document.createElement('div');
		proposedList.className = 'proposed-list';

		for (const lblChange of item.labels || []) {
			const rowDiv = document.createElement('div');
			rowDiv.className = 'proposed-item';
			if (!lblChange.enabled) {
				rowDiv.classList.add('disabled-change');
			}

			const mainDiv = document.createElement('div');
			mainDiv.className = 'proposed-main';

			// Enable/disable checkbox for individual label change
			const lblCheck = document.createElement('input');
			lblCheck.type = 'checkbox';
			lblCheck.checked = Boolean(lblChange.enabled);
			lblCheck.title = 'Toggle this label change';
			lblCheck.addEventListener('change', () => {
				lblChange.enabled = lblCheck.checked;
				renderTable();
				refreshScriptPreview();
			});
			mainDiv.appendChild(lblCheck);

			// Action chip (click to flip ADD <-> REMOVE)
			const actionChip = document.createElement('button');
			actionChip.type = 'button';
			const isRemove = lblChange.action === 'REMOVE';
			actionChip.className = `action-chip ${isRemove ? 'action-remove' : 'action-add'}`;
			actionChip.textContent = isRemove ? '- REMOVE' : '+ ADD';
			actionChip.title = 'Click to flip between ADD and REMOVE';
			actionChip.addEventListener('click', () => {
				lblChange.action = lblChange.action === 'REMOVE' ? 'ADD' : 'REMOVE';
				renderTable();
				refreshScriptPreview();
			});
			mainDiv.appendChild(actionChip);

			// Label name
			const nameSpan = document.createElement('span');
			nameSpan.className = 'proposed-label-name';
			nameSpan.textContent = lblChange.name;
			mainDiv.appendChild(nameSpan);

			// Reason
			if (lblChange.reason) {
				const reasonSpan = document.createElement('span');
				reasonSpan.className = 'proposed-reason';
				reasonSpan.textContent = `— ${lblChange.reason}`;
				mainDiv.appendChild(reasonSpan);
			}

			rowDiv.appendChild(mainDiv);

			// Delete button
			const controlsDiv = document.createElement('div');
			controlsDiv.className = 'proposed-controls';
			const delBtn = document.createElement('button');
			delBtn.type = 'button';
			delBtn.className = 'btn-delete-change';
			delBtn.innerHTML = '&times;';
			delBtn.title = 'Delete this proposed label change';
			delBtn.addEventListener('click', () => {
				item.labels = item.labels.filter((l) => l.id !== lblChange.id);
				renderTable();
				refreshScriptPreview();
			});
			controlsDiv.appendChild(delBtn);
			rowDiv.appendChild(controlsDiv);

			proposedList.appendChild(rowDiv);
		}

		tdProposed.appendChild(proposedList);

		// Inline "+ Add Label Change" form per row
		const addBar = document.createElement('form');
		addBar.className = 'add-change-bar';

		const selectAction = document.createElement('select');
		selectAction.className = 'add-select-action';
		selectAction.setAttribute('aria-label', 'Label action');
		const optAdd = document.createElement('option');
		optAdd.value = 'ADD';
		optAdd.textContent = '+ ADD';
		const optRemove = document.createElement('option');
		optRemove.value = 'REMOVE';
		optRemove.textContent = '- REMOVE';
		selectAction.appendChild(optAdd);
		selectAction.appendChild(optRemove);

		const inputName = document.createElement('input');
		inputName.type = 'text';
		inputName.className = 'add-input-name';
		inputName.placeholder = 'Label name…';
		inputName.setAttribute('list', 'known-labels-datalist');
		inputName.required = true;

		const inputReason = document.createElement('input');
		inputReason.type = 'text';
		inputReason.className = 'add-input-reason';
		inputReason.placeholder = 'Reason (optional)…';

		const submitBtn = document.createElement('button');
		submitBtn.type = 'submit';
		submitBtn.className = 'btn btn-xs btn-secondary';
		submitBtn.textContent = 'Add Change';

		addBar.addEventListener('submit', (e) => {
			e.preventDefault();
			const nameVal = inputName.value.trim();
			if (!nameVal) return;
			item.labels.push({
				id: `lbl-custom-${state.nextCustomLabelId++}`,
				name: nameVal,
				action: selectAction.value === 'REMOVE' ? 'REMOVE' : 'ADD',
				reason: inputReason.value.trim(),
				enabled: true,
			});
			inputName.value = '';
			inputReason.value = '';
			renderTable();
			refreshScriptPreview();
		});

		addBar.appendChild(selectAction);
		addBar.appendChild(inputName);
		addBar.appendChild(inputReason);
		addBar.appendChild(submitBtn);
		tdProposed.appendChild(addBar);

		tr.appendChild(tdProposed);
		triageTbody.appendChild(tr);
	}
}

function applyLoadedData(result) {
	if (!result) return;
	if (result.error) {
		showToast(`YAML Error: ${result.error}`);
		return;
	}
	state.filePath = result.filePath || 'Loaded YAML';
	state.rawYaml = result.rawYaml || '';
	state.items = Array.isArray(result.items) ? result.items : [];
	activeFileBadge.textContent = state.filePath;
	activeFileBadge.title = state.filePath;
	renderTable();
	refreshScriptPreview();
	fetchMissingDescriptions();
}

// Event Listeners
document.getElementById('btn-open-yaml').addEventListener('click', async () => {
	const result = await triageApi.openYamlDialog();
	if (!result || result.canceled) return;
	applyLoadedData(result);
	if (!result.error) {
		showToast(`Loaded ${result.items.length} triage items`);
	}
});

document.getElementById('btn-paste-yaml').addEventListener('click', async () => {
	if (state.items.length > 0) {
		const serialized = await triageApi.serializeYaml(state.items);
		yamlTextarea.value = serialized;
	} else {
		yamlTextarea.value = state.rawYaml || '';
	}
	yamlModalError.classList.add('hidden');
	yamlModalBackdrop.classList.remove('hidden');
	yamlTextarea.focus();
});

function closeYamlModal() {
	yamlModalBackdrop.classList.add('hidden');
}

document.getElementById('btn-close-modal').addEventListener('click', closeYamlModal);
document.getElementById('btn-cancel-yaml').addEventListener('click', closeYamlModal);

document.getElementById('btn-apply-yaml').addEventListener('click', async () => {
	const raw = yamlTextarea.value;
	const result = await triageApi.parseYamlString(raw, 'Edited YAML');
	if (result.error) {
		yamlModalError.textContent = result.error;
		yamlModalError.classList.remove('hidden');
		return;
	}
	closeYamlModal();
	applyLoadedData(result);
	showToast(`Loaded ${result.items.length} triage items from YAML editor`);
});

document.getElementById('btn-export-yaml').addEventListener('click', async () => {
	const res = await triageApi.saveYaml(state.items);
	if (!res.canceled && res.filePath) {
		showToast(`Saved YAML to ${res.filePath}`);
	}
});

document.getElementById('btn-copy-script').addEventListener('click', async () => {
	const script = await triageApi.generateScript(state.items);
	await triageApi.copyToClipboard(script);
	showToast('Copied gh CLI script to clipboard');
});

document.getElementById('btn-save-script').addEventListener('click', async () => {
	const script = await triageApi.generateScript(state.items);
	const res = await triageApi.saveScript(script);
	if (!res.canceled && res.filePath) {
		showToast(`Saved executable script to ${res.filePath}`);
	}
});

// Filter tabs
document.querySelectorAll('.tab-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('.tab-btn').forEach((b) => {
			b.classList.remove('active');
			b.setAttribute('aria-selected', 'false');
		});
		btn.classList.add('active');
		btn.setAttribute('aria-selected', 'true');
		state.filterType = btn.dataset.filter || 'all';
		renderTable();
	});
});

// Search box
searchInput.addEventListener('input', () => {
	state.searchQuery = searchInput.value;
	renderTable();
});

// Select/deselect all visible rows
checkboxSelectAll.addEventListener('change', () => {
	const visible = getFilteredItems();
	for (const item of visible) {
		item.included = checkboxSelectAll.checked;
	}
	renderTable();
	refreshScriptPreview();
});

// Bulk enable/disable all label changes
document.getElementById('btn-enable-all').addEventListener('click', () => {
	for (const item of getFilteredItems()) {
		item.included = true;
		for (const l of item.labels || []) l.enabled = true;
	}
	renderTable();
	refreshScriptPreview();
});

document.getElementById('btn-disable-all').addEventListener('click', () => {
	for (const item of getFilteredItems()) {
		for (const l of item.labels || []) l.enabled = false;
	}
	renderTable();
	refreshScriptPreview();
});

// Toggle script preview collapse
const scriptPanel = document.querySelector('.script-panel');
const btnToggleScript = document.getElementById('btn-toggle-script');
btnToggleScript.addEventListener('click', () => {
	const collapsed = scriptPanel.classList.toggle('collapsed');
	btnToggleScript.textContent = collapsed ? 'Expand Preview' : 'Collapse Preview';
});

// Drag and drop YAML file support anywhere on window
const appShell = document.getElementById('app-shell');
window.addEventListener('dragover', (e) => {
	e.preventDefault();
	appShell.classList.add('drag-over');
});
window.addEventListener('dragleave', (e) => {
	if (e.target === document.documentElement || e.target === document.body) {
		appShell.classList.remove('drag-over');
	}
});
window.addEventListener('drop', async (e) => {
	e.preventDefault();
	appShell.classList.remove('drag-over');
	const file = e.dataTransfer?.files?.[0];
	if (!file) return;
	const text = await file.text();
	const result = await triageApi.parseYamlString(text, file.name);
	applyLoadedData(result);
	if (!result.error) {
		showToast(`Loaded ${file.name}`);
	}
});

// Initial load
(async function init() {
	const initial = await triageApi.getInitialData();
	applyLoadedData(initial);
})();
