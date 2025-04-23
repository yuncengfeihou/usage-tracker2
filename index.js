import { extension_settings, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js"; // Assuming script.js path
// Note: SillyTavern doesn't export toastr directly in standard modules,
// but it's globally available. We'll use it directly.
// import { callPopup, POPUP_TYPE } from "../../../popup.js"; // If needed for confirmation popups

(function () {
    const extensionName = "usage-tracker";
    const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

    // LocalStorage Keys
    const LS_SESSION_START = 'st_usageTracker_sessionStart';
    const LS_LAST_ACTIVE = 'st_usageTracker_lastActive';
    const LS_TRIGGERED_DURATIONS = 'st_usageTracker_triggeredDurations'; // Stores for the current session
    const LS_TRIGGERED_FIXED_TIMES_DATE = 'st_usageTracker_triggeredFixedTimesDate'; // YYYY-MM-DD
    const LS_TRIGGERED_FIXED_TIMES_LIST = 'st_usageTracker_triggeredFixedTimesList'; // Stores for today

    const defaultSettings = {
        enabled: true,
        notifyType: "toastr", // 'toastr', 'browser', 'both'
        enableDurationTracking: true,
        gracePeriodMinutes: 5, // Default 5 minutes
        durationThresholds: [ // In hours
            { value: 1, enabled: true },
            { value: 2, enabled: true },
        ],
        enableFixedTimeTracking: false,
        fixedTimeThresholds: [ // HH:MM format
            { value: "22:00", enabled: true },
        ],
    };

    let settings = {};
    let intervalId = null;
    let sessionTriggeredDurations = []; // Holds duration thresholds (in hours) triggered in this session
    let todayTriggeredFixedTimes = []; // Holds fixed times (HH:MM) triggered today

    // --- Helper Functions ---
    function getTodayDateString() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function log(message) {
        console.log(`[${extensionName}] ${message}`);
    }

    // --- Notification Logic ---
    async function requestNotificationPermission() {
        if (!('Notification' in window)) {
            toastr.error('此浏览器不支持桌面通知。');
            return 'denied';
        }

        if (Notification.permission === 'granted') {
            return 'granted';
        }

        if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                toastr.success('浏览器通知权限已授予！');
            } else {
                toastr.warning('浏览器通知权限被拒绝。');
            }
            return permission;
        }
        return 'denied';
    }

    async function showNotification(message) {
        log(`触发提醒: ${message}`);
        if (!settings.enabled) return;

        const notifyType = settings.notifyType;

        if (notifyType === 'browser' || notifyType === 'both') {
            if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification('SillyTavern 使用提醒', { body: message, icon: '/img/ai4.png' });
                } else if (Notification.permission === 'default') {
                    log('请求通知权限...');
                    const permission = await requestNotificationPermission();
                    if (permission === 'granted') {
                         new Notification('SillyTavern 使用提醒', { body: message, icon: '/img/ai4.png' });
                    } else {
                        log('权限未授予，无法发送浏览器通知。');
                        if (notifyType === 'browser') { // Fallback if ONLY browser was selected
                           toastr.info(message, '使用时长提醒 (浏览器通知被阻止)');
                        }
                    }
                } else {
                     log('浏览器通知权限已被拒绝。');
                      if (notifyType === 'browser') { // Fallback if ONLY browser was selected
                         toastr.info(message, '使用时长提醒 (浏览器通知被阻止)');
                      }
                }
            } else {
                 log('浏览器不支持通知 API。');
                 if (notifyType === 'browser') { // Fallback if ONLY browser was selected
                    toastr.info(message, '使用时长提醒 (浏览器不支持通知)');
                 }
            }
        }

        if (notifyType === 'toastr' || notifyType === 'both') {
            // Always show toastr if it's selected or as a fallback if browser fails initially (permission denied/unsupported)
             if (notifyType === 'both' || (notifyType === 'toastr') || (notifyType === 'browser' && Notification.permission !== 'granted')) {
                toastr.info(message, '使用时长提醒');
             }
        }
    }


    // --- Tracking & Timer Logic ---
    function updateLastActive() {
        const now = Date.now();
        try {
            localStorage.setItem(LS_LAST_ACTIVE, now.toString());
            // log(`Last active timestamp updated: ${new Date(now).toLocaleTimeString()}`);
        } catch (error) {
            console.error(`[${extensionName}] Error saving to localStorage:`, error);
            toastr.error("无法保存追踪状态 (localStorage 错误)。");
        }
    }

    function checkTimers() {
        if (!settings.enabled) {
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
                log("追踪器已禁用，停止计时。");
            }
            return;
        }

        const now = Date.now();
        updateLastActive(); // Keep updating last active as long as the timer runs

        // 1. Check Continuous Duration
        if (settings.enableDurationTracking) {
            try {
                const sessionStartTime = parseInt(localStorage.getItem(LS_SESSION_START) || '0');
                if (sessionStartTime > 0) {
                    const elapsedMs = now - sessionStartTime;
                    const elapsedHours = elapsedMs / (1000 * 60 * 60);

                    settings.durationThresholds.forEach(threshold => {
                        if (threshold.enabled && elapsedHours >= threshold.value) {
                            if (!sessionTriggeredDurations.includes(threshold.value)) {
                                showNotification(`你已经连续使用 SillyTavern 达到 ${threshold.value} 小时！`);
                                sessionTriggeredDurations.push(threshold.value);
                                // Save triggered durations for this session
                                localStorage.setItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`, JSON.stringify(sessionTriggeredDurations));
                            }
                        }
                    });
                }
            } catch (error) {
                 console.error(`[${extensionName}] Error checking duration thresholds:`, error);
            }
        }

        // 2. Check Fixed Time
        if (settings.enableFixedTimeTracking) {
             try {
                const todayStr = getTodayDateString();
                const lastTriggerDate = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_DATE);

                // Reset triggered list if the date changed
                if (lastTriggerDate !== todayStr) {
                    log(`日期已更改 (${lastTriggerDate} -> ${todayStr})，重置固定时间点提醒记录。`);
                    todayTriggeredFixedTimes = [];
                    localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_DATE, todayStr);
                    localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify([]));
                }

                const nowTime = new Date();
                const currentHHMM = `${String(nowTime.getHours()).padStart(2, '0')}:${String(nowTime.getMinutes()).padStart(2, '0')}`;

                settings.fixedTimeThresholds.forEach(threshold => {
                    if (threshold.enabled && threshold.value === currentHHMM) {
                        if (!todayTriggeredFixedTimes.includes(threshold.value)) {
                            showNotification(`已到达预设提醒时间: ${threshold.value}`);
                            todayTriggeredFixedTimes.push(threshold.value);
                            localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify(todayTriggeredFixedTimes));
                        }
                    }
                });
             } catch (error) {
                 console.error(`[${extensionName}] Error checking fixed time thresholds:`, error);
             }
        }
    }

    function initializeTracking() {
        log("初始化追踪器...");
        if (intervalId) {
            clearInterval(intervalId); // Clear existing timer if any
        }

        if (!settings.enabled) {
            log("追踪器已禁用。");
            return;
        }

        try {
            const now = Date.now();
            const lastActiveTimestamp = parseInt(localStorage.getItem(LS_LAST_ACTIVE) || '0');
            let sessionStartTime = parseInt(localStorage.getItem(LS_SESSION_START) || '0');
            const gracePeriodMs = (settings.gracePeriodMinutes || 0) * 60 * 1000;

            const offlineDuration = lastActiveTimestamp > 0 ? now - lastActiveTimestamp : Infinity;

            if (sessionStartTime === 0 || offlineDuration >= gracePeriodMs) {
                // Start a new session
                log(`新会话开始 (离线: ${offlineDuration === Infinity ? 'N/A' : (offlineDuration / 1000).toFixed(1)}s, 宽限期: ${gracePeriodMs / 1000}s)`);
                sessionStartTime = now;
                localStorage.setItem(LS_SESSION_START, sessionStartTime.toString());
                sessionTriggeredDurations = []; // Reset triggers for new session
                // Clear old session's triggers (optional, good for cleanup)
                Object.keys(localStorage).forEach(key => {
                     if (key.startsWith(LS_TRIGGERED_DURATIONS + '_')) {
                         localStorage.removeItem(key);
                     }
                 });
                localStorage.setItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`, JSON.stringify([])); // Initialize for new session
            } else {
                // Continue existing session
                log(`继续现有会话 (离线: ${(offlineDuration / 1000).toFixed(1)}s, 宽限期: ${gracePeriodMs / 1000}s)`);
                // Load triggers for the *current* session
                const triggeredData = localStorage.getItem(`${LS_TRIGGERED_DURATIONS}_${sessionStartTime}`);
                sessionTriggeredDurations = triggeredData ? JSON.parse(triggeredData) : [];
            }

            // Load today's fixed time triggers
            const todayStr = getTodayDateString();
            const lastTriggerDate = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_DATE);
            if (lastTriggerDate === todayStr) {
                const triggeredListData = localStorage.getItem(LS_TRIGGERED_FIXED_TIMES_LIST);
                todayTriggeredFixedTimes = triggeredListData ? JSON.parse(triggeredListData) : [];
            } else {
                 todayTriggeredFixedTimes = []; // New day, reset
                 localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_DATE, todayStr);
                 localStorage.setItem(LS_TRIGGERED_FIXED_TIMES_LIST, JSON.stringify([]));
            }


            updateLastActive(); // Set initial active time
            intervalId = setInterval(checkTimers, 15 * 1000); // Check every 15 seconds
            log(`追踪器已启动，会话开始于: ${new Date(sessionStartTime).toLocaleString()}`);
        } catch (error) {
             console.error(`[${extensionName}] Error initializing tracking:`, error);
             toastr.error("无法初始化使用时长追踪 (localStorage 错误)。");
        }
    }

    // --- UI Rendering and Event Handling ---
    function renderDurationList() {
        const listElement = $('#usageTracker_durationThresholdsList');
        listElement.empty();
        settings.durationThresholds.forEach((threshold, index) => {
            const item = $(`
                <div class="threshold-item" data-index="${index}">
                    <span>${threshold.value} 小时</span>
                    <div>
                        <input type="checkbox" class="duration-enable-checkbox" ${threshold.enabled ? 'checked' : ''}>
                        <button class="menu_button delete-duration" title="删除此阈值"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
            `);
            listElement.append(item);
        });
    }

    function renderFixedTimeList() {
        const listElement = $('#usageTracker_fixedTimesList');
        listElement.empty();
        settings.fixedTimeThresholds.forEach((threshold, index) => {
             const item = $(`
                <div class="threshold-item" data-index="${index}">
                    <span>${threshold.value}</span>
                     <div>
                        <input type="checkbox" class="fixedtime-enable-checkbox" ${threshold.enabled ? 'checked' : ''}>
                        <button class="menu_button delete-fixedtime" title="删除此时间点"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
            `);
            listElement.append(item);
        });
    }

    function bindUIEvents() {
        // General
        $('#usageTracker_enabled').on('change', function() {
            settings.enabled = $(this).is(':checked');
            saveSettingsDebounced();
            initializeTracking(); // Re-initialize to start/stop timer
        });
        $('#usageTracker_notifyType').on('change', function() {
            settings.notifyType = $(this).val();
            saveSettingsDebounced();
            if (settings.notifyType === 'browser' || settings.notifyType === 'both') {
                 $('#usageTracker_requestNotifyPermission').show();
                 requestNotificationPermission(); // Request immediately if selected
            } else {
                 $('#usageTracker_requestNotifyPermission').hide();
            }
        });
         $('#usageTracker_requestNotifyPermission').on('click', requestNotificationPermission);


        // Duration Tracking
        $('#usageTracker_enableDurationTracking').on('change', function() {
            settings.enableDurationTracking = $(this).is(':checked');
            saveSettingsDebounced();
        });
        $('#usageTracker_gracePeriod').on('input', function() {
            const val = parseInt($(this).val());
            if (!isNaN(val) && val >= 0) {
                settings.gracePeriodMinutes = val;
                saveSettingsDebounced();
            }
        });
        $('#usageTracker_addDuration').on('click', function() {
            const input = $('#usageTracker_newDuration');
            const value = parseFloat(input.val());
            if (!isNaN(value) && value > 0) {
                // Avoid duplicates
                if (!settings.durationThresholds.some(t => t.value === value)) {
                    settings.durationThresholds.push({ value: value, enabled: true });
                    settings.durationThresholds.sort((a, b) => a.value - b.value); // Keep sorted
                    saveSettingsDebounced();
                    renderDurationList();
                    input.val(''); // Clear input
                } else {
                     toastr.warning(`阈值 ${value} 小时已存在。`);
                }
            } else {
                toastr.warning('请输入有效的持续时间（大于0的小时数）。');
            }
        });
        $('#usageTracker_durationThresholdsList').on('click', '.delete-duration', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.durationThresholds.splice(index, 1);
            saveSettingsDebounced();
            renderDurationList();
        });
         $('#usageTracker_durationThresholdsList').on('change', '.duration-enable-checkbox', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.durationThresholds[index].enabled = $(this).is(':checked');
            saveSettingsDebounced();
        });

        // Fixed Time Tracking
         $('#usageTracker_enableFixedTimeTracking').on('change', function() {
            settings.enableFixedTimeTracking = $(this).is(':checked');
            saveSettingsDebounced();
        });
        $('#usageTracker_addFixedTime').on('click', function() {
            const input = $('#usageTracker_newFixedTime');
            const value = input.val(); // HH:MM format
            if (value) {
                 // Avoid duplicates
                 if (!settings.fixedTimeThresholds.some(t => t.value === value)) {
                    settings.fixedTimeThresholds.push({ value: value, enabled: true });
                     settings.fixedTimeThresholds.sort((a, b) => a.value.localeCompare(b.value)); // Keep sorted
                    saveSettingsDebounced();
                    renderFixedTimeList();
                    // input.val(''); // Don't clear time input, user might want small adjustments
                 } else {
                      toastr.warning(`时间点 ${value} 已存在。`);
                 }
            } else {
                 toastr.warning('请选择一个有效的时间点。');
            }
        });
        $('#usageTracker_fixedTimesList').on('click', '.delete-fixedtime', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.fixedTimeThresholds.splice(index, 1);
            saveSettingsDebounced();
            renderFixedTimeList();
        });
         $('#usageTracker_fixedTimesList').on('change', '.fixedtime-enable-checkbox', function() {
            const index = $(this).closest('.threshold-item').data('index');
            settings.fixedTimeThresholds[index].enabled = $(this).is(':checked');
            saveSettingsDebounced();
        });

        // Activity listeners
        $(document).on('mousemove keydown click scroll', updateLastActive); // Consider throttling these
        $(window).on('beforeunload', updateLastActive);
        $(document).on('visibilitychange', () => {
             if (document.hidden) {
                 updateLastActive();
             } else {
                 // When tab becomes visible again, re-check state immediately
                 // This handles the case where the interval might have missed the exact moment
                 // the user came back within the grace period.
                 initializeTracking();
             }
         });
    }

    // --- Load Settings and Initialize ---
    async function loadSettings() {
        // Ensure the global settings object has the key for this extension
        extension_settings[extensionName] = extension_settings[extensionName] || {};

        // Merge defaults with saved settings
        settings = { ...defaultSettings, ...extension_settings[extensionName] };

        // Ensure arrays exist and have the correct structure
        settings.durationThresholds = (settings.durationThresholds || [])
            .map(t => (typeof t === 'number' ? { value: t, enabled: true } : t)) // Handle old format if necessary
            .filter(t => typeof t === 'object' && typeof t.value === 'number' && typeof t.enabled === 'boolean');
        settings.fixedTimeThresholds = (settings.fixedTimeThresholds || [])
             .map(t => (typeof t === 'string' ? { value: t, enabled: true } : t)) // Handle old format if necessary
             .filter(t => typeof t === 'object' && typeof t.value === 'string' && typeof t.enabled === 'boolean');


        // Update the UI elements with loaded settings
        $('#usageTracker_enabled').prop('checked', settings.enabled);
        $('#usageTracker_notifyType').val(settings.notifyType);
        $('#usageTracker_requestNotifyPermission').toggle(settings.notifyType === 'browser' || settings.notifyType === 'both');
        $('#usageTracker_enableDurationTracking').prop('checked', settings.enableDurationTracking);
        $('#usageTracker_gracePeriod').val(settings.gracePeriodMinutes);
         $('#usageTracker_enableFixedTimeTracking').prop('checked', settings.enableFixedTimeTracking);

        renderDurationList();
        renderFixedTimeList();
        log("设置已加载。")
    }

    // --- Plugin Entry Point ---
    jQuery(async () => {
        log("插件加载中...");
        try {
            const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
            $("#extensions_settings").append(settingsHtml);
            await loadSettings(); // Load settings first to have them available
            bindUIEvents();
            initializeTracking(); // Start the main logic
             log("插件 UI 和事件已绑定。");
        } catch (error) {
             console.error(`[${extensionName}] Error loading settings.html or initializing:`, error);
             toastr.error("使用时长追踪插件加载失败。");
        }
    });

})();
