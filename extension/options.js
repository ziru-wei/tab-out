'use strict';

const { STORAGE_KEYS: TAB_OUT_STORAGE } = globalThis.TabOutContracts;
const CAPTAIN_CONFIG_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIG_LEGACY;
const CAPTAIN_CONFIGS_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIGS;
const UI_LANGUAGE_KEY = TAB_OUT_STORAGE.UI_LANGUAGE;
const DASHBOARD_COLUMNS_KEY = TAB_OUT_STORAGE.DASHBOARD_COLUMNS;
const READ_LATER_ENABLED_KEY = TAB_OUT_STORAGE.POCKET_ENABLED;
const POCKET_GROUP_LOOSE_TABS_KEY = TAB_OUT_STORAGE.POCKET_GROUP_LOOSE_TABS;
const captainRules = globalThis.TabOutCaptainRules;
const BUILT_IN_CAPTAIN_PROFILES = captainRules.BUILT_IN_PROFILES;
let taskGroupIcons = [...captainRules.TASK_GROUP_ICONS];

const form = document.getElementById('captainForm');
const languageInput = document.getElementById('uiLanguage');
const columnsInput = document.getElementById('dashboardColumns');
const readLaterEnabledInput = document.getElementById('readLaterEnabled');
const pocketGroupingInput = document.getElementById('pocketGroupLooseTabs');
const pocketGroupingField = document.getElementById('pocketGroupingField');
const captainsList = document.getElementById('captainsList');
const addCaptainButton = document.getElementById('addCaptainButton');
const status = document.getElementById('saveStatus');
let uiLanguage = 'zh';

const COPY = {
  en: {
    heading: 'Tab Out Settings', basicSettings: 'Basics', captainSettings: 'Task groups',
    language: 'Language', columns: 'Dashboard columns', twoColumns: 'Two columns', threeColumns: 'Three columns', readLaterSection: 'Pocket', readLaterQuestion: 'Do you need a Pocket?', pocketGrouping: 'Pocket grouping', yes: 'Yes', no: 'No', captainNumber: 'Task group {number}', addCaptain: 'Add task group', deleteCaptain: 'Delete task group', confirmDeleteCaptain: 'Delete “{name}”?', taskGroup: 'Task Group',
    profile: 'Profile', customTaskGroup: 'Custom', matchRules: 'Websites and domains', groupName: 'Alias',
    rulesPlaceholder: 'You can add, for example:\nPDF (for PDF viewer)\nwikipedia.org (for all wiki pages)\nhttps://github.com/ziru-wei/tab-out (for this page only)',
    keepAreaQuestion: 'Keep area?', keepAreaHelp: 'Split this group into Keep and Pending.', groupIcon: ' ',
    groupColor: ' ', grey: 'Grey', blue: 'Blue', red: 'Red', yellow: 'Yellow', green: 'Green', pink: 'Pink', purple: 'Purple', cyan: 'Cyan', orange: 'Orange',
    save: 'Save settings', invalidTaskGroup: 'Enter at least one valid PDF, website, or domain rule for each Task Group.', overlap: 'Task groups cannot use the same or overlapping match rules.', duplicateName: 'Task group aliases must be different.', updated: 'Task groups updated.', saved: 'Saved.', loadError: 'Could not load settings.',
  },
  zh: {
    heading: 'Tab Out 设置', basicSettings: '基础设置', captainSettings: '任务组',
    language: '语言', columns: 'Dashboard 列数', twoColumns: '两列', threeColumns: '三列', readLaterSection: '「口袋」', readLaterQuestion: '是否需要「口袋」？', pocketGrouping: '「口袋」的分组', yes: '需要', no: '不需要', captainNumber: '任务组 {number}', addCaptain: '添加任务组', deleteCaptain: '删除任务组', confirmDeleteCaptain: '确认删除“{name}”？', taskGroup: '任务组',
    profile: 'Profile', customTaskGroup: '自定义', matchRules: '网页和域名', groupName: '别名',
    rulesPlaceholder: '可以添加，例如：\nPDF（匹配 PDF 阅读器）\nwikipedia.org（匹配所有维基页面）\nhttps://github.com/ziru-wei/tab-out（仅匹配这个网页）',
    keepAreaQuestion: '需要「柜子」？', keepAreaHelp: '将此组分成「柜子」和「架子」。', groupIcon: '图',
    groupColor: '色', grey: '灰色', blue: '蓝色', red: '红色', yellow: '黄色', green: '绿色', pink: '粉色', purple: '紫色', cyan: '青色', orange: '橙色',
    save: '保存设置', invalidTaskGroup: '请为每个任务组输入至少一个有效 PDF、网页或域名规则。', overlap: '任务组不能使用相同或互相覆盖的匹配规则。', duplicateName: '任务组别名必须不同。', updated: '任务组已更新。', saved: '已保存。', loadError: '无法加载设置。',
  },
};

function optionText(key, values = {}) {
  return (COPY[uiLanguage][key] || COPY.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}

function captainCardHtml(index) {
  const iconOptions = taskGroupIcons
    .map(icon => `<option value="${icon}">${icon}</option>`)
    .join('');
  return `
    <section class="captain-settings" data-captain-index="${index}">
      <div class="captain-heading">
        <h3 data-captain-title>${optionText('captainNumber', { number: index + 1 })}</h3>
        <button class="delete-captain-button" type="button" data-action="delete-captain" aria-label="${optionText('deleteCaptain')}">-</button>
      </div>
      <div class="captain-details">
        <div class="task-options">
          <label class="field inline-task-field">
            <span>${optionText('profile')}</span>
            <select class="captain-profile" data-field="profile">
              <option value="custom">${optionText('customTaskGroup')}</option>
              <option value="pdf">PDF Only</option>
              <option value="feishu.cn">Feishu / 飞书</option>
              <option value="bambulab.com">Bambu Lab / 拓竹</option>
              <option value="dl.acm.org">Paper Searching</option>
            </select>
          </label>
          <label class="field inline-task-field custom-task-field">
            <span>${optionText('matchRules')}</span>
            <textarea data-field="rules" rows="7" autocomplete="off" placeholder="${optionText('rulesPlaceholder')}"></textarea>
          </label>
          <label class="field inline-task-field">
            <span>${optionText('groupName')}</span>
            <input data-field="title" type="text" maxlength="40">
          </label>
        </div>
        <div class="captain-compact-settings">
          <label class="keep-area-choice" title="${optionText('keepAreaHelp')}">
            <input data-field="keepArea" type="checkbox" checked>
            <span>${optionText('keepAreaQuestion')}</span>
          </label>
          <label class="field compact-select-field">
            <span>${optionText('groupIcon')}</span>
            <select data-field="icon">
              ${iconOptions}
            </select>
          </label>
          <label class="field compact-select-field">
            <span>${optionText('groupColor')}</span>
            <select data-field="color">
              <option value="grey">${optionText('grey')}</option><option value="blue">${optionText('blue')}</option><option value="red">${optionText('red')}</option><option value="yellow">${optionText('yellow')}</option><option value="green">${optionText('green')}</option><option value="pink">${optionText('pink')}</option><option value="purple">${optionText('purple')}</option><option value="cyan">${optionText('cyan')}</option><option value="orange">${optionText('orange')}</option>
            </select>
          </label>
        </div>
      </div>
    </section>`;
}

function directoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => reader.readEntries(batch => {
      if (batch.length === 0) {
        resolve(entries);
        return;
      }
      entries.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

function packageRootEntry() {
  return new Promise((resolve, reject) => {
    if (typeof chrome.runtime.getPackageDirectoryEntry !== 'function') {
      reject(new Error('Package directory enumeration is unavailable'));
      return;
    }
    chrome.runtime.getPackageDirectoryEntry(resolve);
  });
}

function childDirectory(parent, path) {
  return new Promise((resolve, reject) => parent.getDirectory(path, {}, resolve, reject));
}

async function loadTaskGroupIcons() {
  try {
    const root = await packageRootEntry();
    const directory = await childDirectory(root, 'assets/icons/task-groups');
    const entries = await directoryEntries(directory.createReader());
    const discovered = entries
      .filter(entry => entry.isFile && /\.svg$/i.test(entry.name))
      .map(entry => entry.name.replace(/\.svg$/i, ''))
      .filter(name => /^[a-z0-9][a-z0-9_-]*$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    if (discovered.length > 0) taskGroupIcons = discovered;
  } catch (error) {
    console.warn('[tab-out] Could not enumerate Task Group icons:', error);
  }
}

function captainCards() {
  return [...captainsList.querySelectorAll('.captain-settings')];
}

function fields(card) {
  return {
    profile: card.querySelector('[data-field="profile"]'),
    rules: card.querySelector('[data-field="rules"]'),
    title: card.querySelector('[data-field="title"]'),
    color: card.querySelector('[data-field="color"]'),
    keepArea: card.querySelector('[data-field="keepArea"]'),
    icon: card.querySelector('[data-field="icon"]'),
  };
}

function applyBuiltInCaptainProfile(card) {
  const controls = fields(card);
  const profile = BUILT_IN_CAPTAIN_PROFILES[controls.profile.value]
    || captainRules.builtInProfileForRules(captainRules.normalizeTaskRules(controls.rules.value));
  if (!profile) return false;
  controls.rules.value = profile.matchRules.join('\n');
  controls.title.value = profile.title;
  controls.color.value = profile.color;
  controls.icon.value = profile.icon || 'circle';
  return true;
}

function syncProfileControl(card) {
  const controls = fields(card);
  const rules = captainRules.normalizeTaskRules(controls.rules.value);
  const profile = captainRules.builtInProfileForRules(rules);
  const profileKey = profile
    ? Object.keys(BUILT_IN_CAPTAIN_PROFILES).find(key => BUILT_IN_CAPTAIN_PROFILES[key] === profile)
    : '';
  controls.profile.value = profileKey || 'custom';
}

function populateConfig(card, config) {
  const controls = fields(card);
  controls.rules.value = captainRules.serializeTaskRules(config.matchRules).join('\n');
  controls.title.value = config.customTitle;
  controls.color.value = config.groupColor;
  controls.keepArea.checked = config.keepAreaEnabled;
  controls.icon.value = config.icon;
  syncProfileControl(card);
}

const normalizeConfig = captainRules.normalizeConfig;
const normalizeConfigs = captainRules.normalizeConfigs;
const configKey = captainRules.configKey;

function effectiveTitle(config) {
  return config.customTitle || config.domain
    || (config.matchRules.some(rule => rule.kind === 'pdf') ? 'PDF' : '');
}

function readConfig(card, index) {
  const controls = fields(card);
  return normalizeConfig({
    enabled: true,
    type: 'task',
    matchRules: captainRules.normalizeTaskRules(controls.rules.value),
    customTitle: controls.title.value,
    groupColor: controls.color.value,
    keepAreaEnabled: controls.keepArea.checked,
    icon: controls.icon.value,
  }, index);
}

function readConfigs() {
  return captainCards().map(readConfig);
}

function renderCaptains(configs) {
  const activeConfigs = configs.filter(config => config.enabled !== false);
  captainsList.innerHTML = activeConfigs.map((_, index) => captainCardHtml(index)).join('');
  captainCards().forEach((card, index) => populateConfig(card, normalizeConfig(activeConfigs[index], index)));
}

function applyLanguage() {
  document.documentElement.lang = uiLanguage === 'zh' ? 'zh-CN' : 'en';
  document.title = uiLanguage === 'zh' ? 'Tab Out 设置' : 'Tab Out Settings';
  addCaptainButton.setAttribute('aria-label', optionText('addCaptain'));
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = optionText(element.dataset.i18n); });
  renderCaptains(readConfigs());
}

function syncReadLaterFields() {
  const enabled = readLaterEnabledInput.value !== 'no';
  pocketGroupingField.classList.toggle('is-hidden', !enabled);
  pocketGroupingInput.disabled = !enabled;
}

async function loadOptions() {
  const stored = await chrome.storage.local.get([CAPTAIN_CONFIGS_KEY, CAPTAIN_CONFIG_KEY, UI_LANGUAGE_KEY, DASHBOARD_COLUMNS_KEY, READ_LATER_ENABLED_KEY, POCKET_GROUP_LOOSE_TABS_KEY]);
  uiLanguage = stored[UI_LANGUAGE_KEY] === 'en' ? 'en' : 'zh';
  languageInput.value = uiLanguage;
  columnsInput.value = stored[DASHBOARD_COLUMNS_KEY] === 2 ? '2' : '3';
  readLaterEnabledInput.value = stored[READ_LATER_ENABLED_KEY] === true ? 'yes' : 'no';
  pocketGroupingInput.value = stored[POCKET_GROUP_LOOSE_TABS_KEY] === false ? 'loose' : 'grouped';
  renderCaptains(normalizeConfigs(stored[CAPTAIN_CONFIGS_KEY], stored[CAPTAIN_CONFIG_KEY]));
  applyLanguage();
  syncReadLaterFields();
}

form.addEventListener('change', event => {
  if (event.target === readLaterEnabledInput) syncReadLaterFields();
  if (event.target === languageInput) {
    uiLanguage = languageInput.value === 'zh' ? 'zh' : 'en';
    applyLanguage();
    chrome.storage.local.set({ [UI_LANGUAGE_KEY]: uiLanguage });
    return;
  }
  const card = event.target.closest('.captain-settings');
  if (!card) return;
  if (event.target.matches('[data-field="profile"]')) {
    const controls = fields(card);
    if (controls.profile.value === 'custom') {
      controls.rules.value = '';
      controls.rules.focus();
    } else {
      applyBuiltInCaptainProfile(card);
    }
  }
});

form.addEventListener('input', event => {
  const card = event.target.closest('.captain-settings');
  if (card && event.target.matches('[data-field="rules"]')) syncProfileControl(card);
});

captainsList.addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-action="delete-captain"]');
  if (!deleteButton) return;
  const card = deleteButton.closest('.captain-settings');
  const cardIndex = captainCards().indexOf(card);
  if (!card || cardIndex < 0) return;
  const next = readConfigs();
  const config = next[cardIndex];
  const name = effectiveTitle(config)
    || optionText('captainNumber', { number: cardIndex + 1 });
  if (!window.confirm(optionText('confirmDeleteCaptain', { name }))) return;
  next.splice(cardIndex, 1);
  renderCaptains(next);
  status.textContent = '';
});

addCaptainButton.addEventListener('click', () => {
  const next = readConfigs();
  next.push(normalizeConfig({ enabled: true, type: 'task', matchRules: [], customTitle: '', groupColor: 'grey', keepAreaEnabled: true, icon: 'circle' }, next.length));
  renderCaptains(next);
  captainCards().at(-1)?.querySelector('[data-field="rules"]')?.focus();
  status.textContent = '';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = '';
  const next = readConfigs();
  const invalidIndex = next.findIndex(config => config.matchRules.length === 0);
  if (invalidIndex >= 0) {
    status.textContent = optionText('invalidTaskGroup');
    fields(captainCards()[invalidIndex]).rules.focus();
    return;
  }
  for (let firstIndex = 0; firstIndex < next.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < next.length; secondIndex += 1) {
      const first = next[firstIndex];
      const second = next[secondIndex];
      if (captainRules.taskRulesOverlap(first.matchRules, second.matchRules)) {
        status.textContent = optionText('overlap');
        return;
      }
      if (effectiveTitle(first).toLowerCase() === effectiveTitle(second).toLowerCase()) {
        status.textContent = optionText('duplicateName');
        return;
      }
    }
  }

  const stored = await chrome.storage.local.get([CAPTAIN_CONFIGS_KEY, CAPTAIN_CONFIG_KEY]);
  const previous = normalizeConfigs(stored[CAPTAIN_CONFIGS_KEY], stored[CAPTAIN_CONFIG_KEY]).filter(config => config.enabled !== false);
  const changed = previous.length !== next.length || next.some((config, index) => {
    const prior = previous[index];
    return !prior
      || configKey(prior) !== configKey(config)
      || JSON.stringify(config.matchRules) !== JSON.stringify(prior.matchRules)
      || effectiveTitle(prior) !== effectiveTitle(config)
      || config.groupColor !== prior.groupColor
      || config.keepAreaEnabled !== prior.keepAreaEnabled
      || config.icon !== prior.icon;
  });
  await chrome.storage.local.set({
    [CAPTAIN_CONFIGS_KEY]: next,
    [DASHBOARD_COLUMNS_KEY]: columnsInput.value === '2' ? 2 : 3,
    [READ_LATER_ENABLED_KEY]: readLaterEnabledInput.value !== 'no',
    [POCKET_GROUP_LOOSE_TABS_KEY]: pocketGroupingInput.value !== 'loose',
  });
  renderCaptains(next);
  status.textContent = changed ? optionText('updated') : optionText('saved');
});

loadTaskGroupIcons()
  .then(loadOptions)
  .catch(() => { status.textContent = optionText('loadError'); });
