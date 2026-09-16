'use strict';

const { STORAGE_KEYS: TAB_OUT_STORAGE } = globalThis.TabOutContracts;
const CAPTAIN_CONFIG_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIG_LEGACY;
const CAPTAIN_CONFIGS_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIGS;
const UI_LANGUAGE_KEY = TAB_OUT_STORAGE.UI_LANGUAGE;
const DASHBOARD_COLUMNS_KEY = TAB_OUT_STORAGE.DASHBOARD_COLUMNS;
const DAILY_QUOTES_ENABLED_KEY = TAB_OUT_STORAGE.DAILY_QUOTES_ENABLED;
const READ_LATER_ENABLED_KEY = TAB_OUT_STORAGE.POCKET_ENABLED;
const POCKET_GROUP_LOOSE_TABS_KEY = TAB_OUT_STORAGE.POCKET_GROUP_LOOSE_TABS;
const captainRules = globalThis.TabOutCaptainRules;
const BUILT_IN_CAPTAIN_PROFILES = captainRules.BUILT_IN_PROFILES;

const form = document.getElementById('captainForm');
const languageInput = document.getElementById('uiLanguage');
const columnsInput = document.getElementById('dashboardColumns');
const dailyQuotesEnabledInput = document.getElementById('dailyQuotesEnabled');
const readLaterEnabledInput = document.getElementById('readLaterEnabled');
const pocketGroupingInput = document.getElementById('pocketGroupLooseTabs');
const pocketGroupingField = document.getElementById('pocketGroupingField');
const captainsList = document.getElementById('captainsList');
const captainsEmpty = document.getElementById('captainsEmpty');
const addCaptainButton = document.getElementById('addCaptainButton');
const status = document.getElementById('saveStatus');
let uiLanguage = 'en';

const COPY = {
  en: {
    heading: 'Tab Out Settings', basicSettings: 'Basics', captainSettings: 'Task groups',
    language: 'Language', columns: 'Dashboard columns', twoColumns: 'Two columns', threeColumns: 'Three columns', dailyQuotes: 'Daily quotes', show: 'Show', hide: 'Hide', readLaterSection: 'Pocket', readLaterQuestion: 'Do you need a Pocket?', pocketGrouping: 'Pocket grouping', pocketGroupingHelp: 'No shows every Pocket item as a single chip.', yes: 'Yes', no: 'No', captainNumber: 'Task group {number}', addCaptain: 'Add task group', deleteCaptain: 'Delete', noCaptains: 'No task groups. Add one if you need rule-based grouping.', pdfHelp: 'Match PDF tabs.', taskGroup: 'Task Group',
    profile: 'Profile', chooseProfile: 'Choose a profile', customTaskGroup: 'Custom Task Group', matchRules: 'Websites and domains', matchRulesHelp: 'Use a bare domain for the whole site or a full URL for one exact page. Separate entries with commas, spaces, semicolons, or new lines.', groupName: 'Alias',
    keepAreaQuestion: 'Keep area needed?', keepAreaHelp: 'Split this group into Keep and Pending.', groupIcon: 'Icon', circleIcon: 'Circle', bookIcon: 'Book', bambuIcon: 'Bambu',
    groupColor: 'Color', grey: 'Grey', blue: 'Blue', red: 'Red', yellow: 'Yellow', green: 'Green', pink: 'Pink', purple: 'Purple', cyan: 'Cyan', orange: 'Orange',
    save: 'Save settings', invalidTaskGroup: 'Enter at least one valid website or domain for each Task Group.', overlap: 'Task groups cannot use the same or overlapping match rules.', duplicateName: 'Task group aliases must be different.', updated: 'Task groups updated.', saved: 'Saved.', loadError: 'Could not load settings.',
  },
  zh: {
    heading: 'Tab Out 设置', basicSettings: '基础设置', captainSettings: '任务组',
    language: '语言', columns: 'Dashboard 列数', twoColumns: '两列', threeColumns: '三列', dailyQuotes: '每日引言', show: '显示', hide: '隐藏', readLaterSection: '「口袋」', readLaterQuestion: '是否需要「口袋」？', pocketGrouping: '「口袋」的分组', pocketGroupingHelp: '选择“不需要”时，每个口袋标签显示为单独的 chip。', yes: '需要', no: '不需要', captainNumber: '任务组 {number}', addCaptain: '添加任务组', deleteCaptain: '删除', noCaptains: '当前没有任务组。如需按规则分组，可添加一个。', pdfHelp: '匹配 PDF 标签页。', taskGroup: '任务组',
    profile: 'Profile', chooseProfile: '选择 Profile', customTaskGroup: '自定义任务组', matchRules: '网页和域名', matchRulesHelp: '裸域名匹配整个站点，完整 URL 只匹配单个页面。使用逗号、空格、分号或换行分隔。', groupName: '别名',
    keepAreaQuestion: '需要保留区？', keepAreaHelp: '将此组分成保留区和待处理区。', groupIcon: '图标', circleIcon: '圆形', bookIcon: '书本', bambuIcon: '竹子',
    groupColor: '颜色', grey: '灰色', blue: '蓝色', red: '红色', yellow: '黄色', green: '绿色', pink: '粉色', purple: '紫色', cyan: '青色', orange: '橙色',
    save: '保存设置', invalidTaskGroup: '请为每个任务组输入至少一个有效网页或域名。', overlap: '任务组不能使用相同或互相覆盖的匹配规则。', duplicateName: '任务组别名必须不同。', updated: '任务组已更新。', saved: '已保存。', loadError: '无法加载设置。',
  },
};

function optionText(key, values = {}) {
  return (COPY[uiLanguage][key] || COPY.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}

function captainCardHtml(index) {
  return `
    <section class="captain-settings" data-captain-index="${index}">
      <div class="captain-heading">
        <h3 data-captain-title>${optionText('captainNumber', { number: index + 1 })}</h3>
        <button class="delete-captain-button" type="button" data-action="delete-captain">${optionText('deleteCaptain')}</button>
      </div>
      <fieldset class="captain-type-options">
        <label class="choice type-choice">
          <input type="radio" name="captainType${index}" value="pdf" checked>
          <span><strong>PDF</strong><small>${optionText('pdfHelp')}</small></span>
        </label>
        <label class="choice type-choice">
          <input type="radio" name="captainType${index}" value="task">
          <span><strong>${optionText('taskGroup')}</strong></span>
        </label>
      </fieldset>
      <div class="captain-details">
        <div class="task-options" data-field="taskFields" hidden>
          <label class="field inline-task-field">
            <span>${optionText('profile')}</span>
            <select class="captain-profile" data-field="profile">
              <option value="">${optionText('chooseProfile')}</option>
              <option value="feishu.cn">Feishu / 飞书</option>
              <option value="bambulab.com">Bambu Lab / 拓竹</option>
              <option value="dl.acm.org">ACM Digital Library</option>
              <option value="custom">${optionText('customTaskGroup')}</option>
            </select>
          </label>
          <label class="field inline-task-field custom-task-field">
            <span>${optionText('matchRules')}</span>
            <textarea data-field="rules" rows="3" placeholder="example.com&#10;https://another.example/specific-page" autocomplete="off"></textarea>
            <small class="field-help">${optionText('matchRulesHelp')}</small>
          </label>
          <label class="field inline-task-field">
            <span>${optionText('groupName')}</span>
            <input data-field="title" type="text" maxlength="40" placeholder="${uiLanguage === 'zh' ? '默认使用第一个匹配项' : 'Uses the first match by default'}">
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
              <option value="circle">${optionText('circleIcon')}</option>
              <option value="book">${optionText('bookIcon')}</option>
              <option value="bambu">${optionText('bambuIcon')}</option>
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

function captainCards() {
  return [...captainsList.querySelectorAll('.captain-settings')];
}

function fields(card) {
  return {
    taskFields: card.querySelector('[data-field="taskFields"]'),
    profile: card.querySelector('[data-field="profile"]'),
    rules: card.querySelector('[data-field="rules"]'),
    title: card.querySelector('[data-field="title"]'),
    color: card.querySelector('[data-field="color"]'),
    keepArea: card.querySelector('[data-field="keepArea"]'),
    icon: card.querySelector('[data-field="icon"]'),
  };
}

function selectedType(card) {
  return card.querySelector('input[type="radio"]:checked')?.value || 'pdf';
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
  controls.profile.value = profileKey || (rules.length > 0 ? 'custom' : '');
}

function syncCard(card) {
  const taskEnabled = selectedType(card) === 'task';
  fields(card).taskFields.hidden = !taskEnabled;
}

function populateConfig(card, config) {
  const controls = fields(card);
  const typeControl = card.querySelector(`input[value="${config.type}"]`);
  if (typeControl) typeControl.checked = true;
  controls.rules.value = captainRules.serializeTaskRules(config.matchRules).join('\n');
  controls.title.value = config.customTitle;
  controls.color.value = config.groupColor;
  controls.keepArea.checked = config.keepAreaEnabled;
  controls.icon.value = config.icon;
  syncProfileControl(card);
  syncCard(card);
}

const normalizeConfig = captainRules.normalizeConfig;
const normalizeConfigs = captainRules.normalizeConfigs;
const configKey = captainRules.configKey;

function effectiveTitle(config) {
  return config.customTitle || (config.type === 'task' ? config.domain : 'PDF');
}

function readConfig(card, index) {
  const controls = fields(card);
  const type = selectedType(card);
  return normalizeConfig({
    enabled: true,
    type,
    matchRules: type === 'task' ? captainRules.normalizeTaskRules(controls.rules.value) : [],
    customTitle: type === 'task' ? controls.title.value : '',
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
  captainsEmpty.hidden = activeConfigs.length > 0;
}

function applyLanguage() {
  document.documentElement.lang = uiLanguage === 'zh' ? 'zh-CN' : 'en';
  document.title = uiLanguage === 'zh' ? 'Tab Out 设置' : 'Tab Out Settings';
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = optionText(element.dataset.i18n); });
  renderCaptains(readConfigs());
}

function syncReadLaterFields() {
  const enabled = readLaterEnabledInput.value !== 'no';
  pocketGroupingField.classList.toggle('is-hidden', !enabled);
  pocketGroupingInput.disabled = !enabled;
}

async function loadOptions() {
  const stored = await chrome.storage.local.get([CAPTAIN_CONFIGS_KEY, CAPTAIN_CONFIG_KEY, UI_LANGUAGE_KEY, DASHBOARD_COLUMNS_KEY, DAILY_QUOTES_ENABLED_KEY, READ_LATER_ENABLED_KEY, POCKET_GROUP_LOOSE_TABS_KEY]);
  uiLanguage = stored[UI_LANGUAGE_KEY] === 'zh' ? 'zh' : 'en';
  languageInput.value = uiLanguage;
  columnsInput.value = stored[DASHBOARD_COLUMNS_KEY] === 2 ? '2' : '3';
  dailyQuotesEnabledInput.value = stored[DAILY_QUOTES_ENABLED_KEY] === false ? 'no' : 'yes';
  readLaterEnabledInput.value = stored[READ_LATER_ENABLED_KEY] === false ? 'no' : 'yes';
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
  if (event.target.matches('input[type="radio"]')) {
    syncCard(card);
    if (event.target.value === 'task') applyBuiltInCaptainProfile(card);
  }
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
  const next = readConfigs();
  next.splice(captainCards().indexOf(card), 1);
  renderCaptains(next);
  status.textContent = '';
});

addCaptainButton.addEventListener('click', () => {
  const next = readConfigs();
  next.push(normalizeConfig({ enabled: true, type: 'task', matchRules: [], customTitle: '', groupColor: 'grey', keepAreaEnabled: true, icon: 'circle' }, next.length));
  renderCaptains(next);
  captainCards().at(-1)?.querySelector('[data-field="profile"]')?.focus();
  status.textContent = '';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = '';
  const next = readConfigs();
  const invalidIndex = next.findIndex(config => config.type === 'task' && config.matchRules.length === 0);
  if (invalidIndex >= 0) {
    status.textContent = optionText('invalidTaskGroup');
    fields(captainCards()[invalidIndex]).rules.focus();
    return;
  }
  for (let firstIndex = 0; firstIndex < next.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < next.length; secondIndex += 1) {
      const first = next[firstIndex];
      const second = next[secondIndex];
      const rulesOverlap = first.type === 'task' && second.type === 'task'
        && captainRules.taskRulesOverlap(first.matchRules, second.matchRules);
      if ((first.type === 'pdf' && second.type === 'pdf') || rulesOverlap) {
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
    [DAILY_QUOTES_ENABLED_KEY]: dailyQuotesEnabledInput.value !== 'no',
    [READ_LATER_ENABLED_KEY]: readLaterEnabledInput.value !== 'no',
    [POCKET_GROUP_LOOSE_TABS_KEY]: pocketGroupingInput.value !== 'loose',
  });
  renderCaptains(next);
  status.textContent = changed ? optionText('updated') : optionText('saved');
});

loadOptions().catch(() => { status.textContent = optionText('loadError'); });
