// ==UserScript==
// @name         YouTube Transcript Copier (Optimized SPA Version)
// @match        https://www.youtube.com/*
// @grant        none
// @version      1.3
// @author       Amir Tehrani
// @description  Adds a styled button to copy the YouTube video transcript, with a timestamp toggle. Works on playlist pages, soft-navigation, and tabbed "In this video" / modern transcript view panel (ignores hidden dummy panels).
// @namespace    https://greasyfork.org/
// @icon         https://www.google.com/s2/favicons?domain=youtube.com
// ==/UserScript==

(function() {
    'use strict';

    let retryInterval = null;
    let includeTimestamps = false; // Default: no timestamps
    let copyButton = null;
    let buttonTextNode = null;
    let transcriptPanelTimeout = null; // Timeout for panel loading
    let transcriptButtonTimeout = null; // Timeout for the "Show transcript" button

    // Handles the Single Page Application (SPA) navigation logic
    function handleNavigation() {
        resetState();

        // Check if we are on a video page
        if (window.location.pathname === '/watch') {
            if (!createTranscriptButton()) {
                retryInterval = setInterval(attemptButtonCreation, 500);
            }
        }
    }

    // Listen for YouTube's internal finish event to trigger the script
    window.addEventListener('yt-navigate-finish', handleNavigation);

    // Initial run for the first page load
    handleNavigation();

    // ---------------------------------------------------------------
    // Panel / segment detection (supports old, modern, and tabbed layouts)
    // ---------------------------------------------------------------
    //
    // Layouts:
    //  - Legacy: ytd-transcript-segment-renderer inside
    //      ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]
    //  - Modern/tabbed ("In this video"): transcript-segment-view-model inside
    //      yt-section-list-renderer[data-target-id="PAmodern_transcript_view"]
    //      (inner data-target-id — the OUTER panel may not carry target-id at all)
    //
    // TRAP: YouTube also renders a HIDDEN dummy panel with
    //   target-id="PAmodern_transcript_view" + visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"
    //   containing only a spinner. Never match hidden panels.

    const SEGMENT_SELECTOR = 'transcript-segment-view-model, .ytwTranscriptSegmentViewModelHost, ytd-transcript-segment-renderer';
    const TIMESTAMP_RE = /^\d+:\d{2}(:\d{2})?$/;

    function log(...args) {
        console.log('[YT Transcript Copier]', ...args);
    }

    function isPanelVisible(panel) {
        if (panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') return false;
        if (panel.offsetParent === null) return false;
        return true;
    }

    // Returns the panel element that actually contains loaded, visible segments, or null
    function findLoadedTranscriptPanel() {
        const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
        for (const panel of panels) {
            if (!isPanelVisible(panel)) continue;

            // A visible panel qualifies if it looks like the transcript panel:
            //  (a) contains the inner modern transcript container, OR
            //  (b) contains a "Search transcript" input, OR
            //  (c) directly contains transcript segments (legacy)
            const hasModernContainer = panel.querySelector('[data-target-id="PAmodern_transcript_view"], [data-target-id*="transcript"]');
            const hasSearchBox = panel.querySelector('textarea[aria-label="Search transcript"], textarea[placeholder="Search transcript"], input[placeholder="Search transcript"]');
            const segments = panel.querySelectorAll(SEGMENT_SELECTOR);

            if ((hasModernContainer || hasSearchBox || segments.length > 0)) {
                if (segments.length > 0) {
                    log('Panel matched (visible, segments loaded):', panel.getAttribute('target-id') || '(no target-id)', '| segments:', segments.length);
                    return panel;
                }
                // Transcript-looking panel found but segments not rendered yet — keep polling
                log('Transcript panel visible but segments not loaded yet:', panel.getAttribute('target-id') || '(no target-id)');
            }
        }
        return null;
    }

    // Extracts { timestamp, text } from a segment element of any layout
    function extractSegmentData(segment) {
        const tag = segment.tagName.toLowerCase();
        if (tag === 'transcript-segment-view-model' || segment.classList.contains('ytwTranscriptSegmentViewModelHost')) {
            // Modern layout
            const timestampElement = segment.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
            const textElement = segment.querySelector('.ytAttributedStringHost[role="text"], span[role="text"], .ytAttributedStringHost');
            let timestamp = timestampElement ? timestampElement.textContent.trim() : '';
            // Fallback: scan children for something that looks like a timecode
            if (!timestamp) {
                for (const child of segment.querySelectorAll('div, span')) {
                    const t = child.textContent.trim();
                    if (TIMESTAMP_RE.test(t)) { timestamp = t; break; }
                }
            }
            return {
                timestamp: timestamp,
                text: textElement ? textElement.textContent.trim() : ''
            };
        }
        // Legacy layout
        const timestampElement = segment.querySelector('.segment-timestamp');
        const textElement = segment.querySelector('.segment-text');
        return {
            timestamp: timestampElement ? timestampElement.textContent.trim() : '',
            text: textElement ? textElement.textContent.trim() : ''
        };
    }

    // Last-resort extraction: walk the panel pairing timecode nodes with adjacent text
    function fallbackExtract(panel) {
        log('Running fallback node-walk extraction...');
        const results = [];
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_ELEMENT);
        let currentTimestamp = '';
        let node;
        while ((node = walker.nextNode())) {
            // Only inspect leaf-ish elements to avoid duplicated concatenated text
            if (node.children.length > 0) continue;
            const t = node.textContent.trim();
            if (!t) continue;
            if (TIMESTAMP_RE.test(t)) {
                currentTimestamp = t;
            } else if (node.matches('span[role="text"], .ytAttributedStringHost, .segment-text') ||
                       (currentTimestamp && t.length > 1 && !node.closest('#header, form, button'))) {
                results.push({ timestamp: currentTimestamp, text: t });
                currentTimestamp = '';
            }
        }
        log('Fallback extraction found', results.length, 'entries');
        return results;
    }

    function createTranscriptButton() {
        if (document.getElementById('show-transcript-button')) {
            return true;
        }

        copyButton = document.createElement('button');
        copyButton.id = 'show-transcript-button';
        copyButton.classList.add('yt-transcript-button');
        copyButton.setAttribute('aria-label', 'Copy Transcript'); // Accessibility

        buttonTextNode = document.createTextNode('Copy Transcript');
        copyButton.appendChild(buttonTextNode);

        const timestampSpan = document.createElement('span');
        timestampSpan.id = 'timestamp-toggle';
        timestampSpan.textContent = ' (No Time)';
        timestampSpan.style.cssText = `
            font-size: 0.75em;
            margin-left: 6px;
            color: rgba(255, 255, 255, 0.7);
            cursor: pointer;
            user-select: none;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 12px;
            padding: 3px 6px;
            display: inline-block;
            vertical-align: middle;
            transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
            background-color: rgba(0, 0, 0, 0.1);
        `;

        timestampSpan.addEventListener('mouseover', function() {
            this.style.borderColor = 'rgba(255, 255, 255, 0.9)';
            this.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
        });
        timestampSpan.addEventListener('mouseout', function() {
            this.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
            this.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
        });

        copyButton.appendChild(timestampSpan);

        timestampSpan.addEventListener('click', function(event) {
            event.stopPropagation(); // Prevent main button click
            includeTimestamps = !includeTimestamps;
            this.textContent = includeTimestamps ? ' (Time)' : ' (No Time)';
            this.style.color = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.7)';
            this.style.borderColor = includeTimestamps ? 'white' : 'rgba(255, 255, 255, 0.3)';
            this.style.backgroundColor = includeTimestamps ? 'rgba(0,0,0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
        });

        copyButton.addEventListener('click', handleCopyClick);

        return insertButton();
    }

    function insertButton() {
        // List of potential targets to handle different YouTube layouts (e.g., playlist vs. standard).
        const potentialTargets = [
            '#owner', // Reliable on both layouts, next to channel info
            '#above-the-fold #actions-inner', // Reliable on both layouts, inside like/share container
            '#top-row.ytd-watch-metadata', // Reliable fallback
            '#meta-contents', // Original target, works on non-playlist pages
            '#above-the-fold' // Final fallback
        ];

        for (const targetSelector of potentialTargets) {
            const targetElement = document.querySelector(targetSelector);
            // Check if  element exists AND is visible before inserting the button.
            if (targetElement && targetElement.offsetParent !== null) {
                targetElement.parentNode.insertBefore(copyButton, targetElement.nextSibling);
                injectStyles();
                return true;
            }
        }
        return false;
    }

    function handleCopyClick() {
        updateButtonText('Copying...');

        const playlistPanel = document.querySelector('ytd-playlist-panel-renderer#playlist');

        // Function called to restore the UI to  original state
        function cleanupUI() {
            if (playlistPanel) {
                playlistPanel.style.display = ''; // Restore playlist visibility
            }
        }

        // On playlist pages,  playlist panel conflicts with  transcript panel
        // Temporarily hide it to allow  transcript to load
        if (playlistPanel) {
            playlistPanel.style.display = 'none';
        }

        // Fast path: if transcript panel is open and loaded, copy immediately.
        const alreadyLoadedPanel = findLoadedTranscriptPanel();
        if (alreadyLoadedPanel) {
            copyTranscriptText(alreadyLoadedPanel, cleanupUI);
            return;
        }

        // The "Show transcript" button lives in the description's transcript section.
        // Try directly first; fall back to opening the "More actions" menu (old flow).
        let transcriptButton = document.querySelector('[aria-label="Show transcript"]');
        if (transcriptButton) {
            transcriptButton.click();
            waitForTranscriptPanel(cleanupUI);
            return;
        }

        const moreActionsButton = document.querySelector('button[aria-label="More actions"]');
        if (!moreActionsButton) {
            console.error("Could not find 'Show transcript' or 'More actions' button.");
            updateButtonText("Error");
            copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            cleanupUI();
            return;
        }
        moreActionsButton.click();

        const buttonIntervalId = setInterval(() => {
            transcriptButton = document.querySelector('[aria-label="Show transcript"]');
            if (transcriptButton) {
                transcriptButton.click();
                clearInterval(buttonIntervalId);
                clearTimeout(transcriptButtonTimeout);
                waitForTranscriptPanel(cleanupUI);
            }
        }, 250);

        transcriptButtonTimeout = setTimeout(() => {
            clearInterval(buttonIntervalId);
            if (copyButton) {
                updateButtonText("Transcript Not Found");
                copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            }
            console.error("Transcript button not found after timeout.");
            cleanupUI();
        }, 10000);
    }

    // Polls for either the old or new transcript panel to finish loading segments
    function waitForTranscriptPanel(cleanupUI) {
        const panelIntervalId = setInterval(() => {
            const transcriptPanel = findLoadedTranscriptPanel();
            if (transcriptPanel) {
                clearInterval(panelIntervalId);
                clearTimeout(transcriptPanelTimeout);
                copyTranscriptText(transcriptPanel, cleanupUI);
            }
        }, 100);

        transcriptPanelTimeout = setTimeout(() => {
            clearInterval(panelIntervalId);
            console.error("Transcript panel or segments not found after timeout.");
            if (copyButton) {
                updateButtonText("Transcript Not Found");
                copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            }
            cleanupUI();
        }, 15000);
    }

    function copyTranscriptText(transcriptPanel, cleanupCallback) {
        if (!transcriptPanel) {
            console.error("Transcript container not found.");
            updateButtonText("Error");
            if (cleanupCallback) cleanupCallback();
            return;
        }

        const segments = transcriptPanel.querySelectorAll(SEGMENT_SELECTOR);
        log('copyTranscriptText: found', segments.length, 'segment elements');

        let entries = [];
        segments.forEach(segment => {
            const data = extractSegmentData(segment);
            if (data.text) entries.push(data);
        });

        // If class-based extraction produced nothing, fall back to node walking
        if (entries.length === 0) {
            entries = fallbackExtract(transcriptPanel);
        }

        let transcriptText = "";
        entries.forEach(({ timestamp, text }) => {
            if (includeTimestamps) {
                transcriptText += (timestamp ? timestamp + " " : "") + text + "\n";
            } else {
                transcriptText += text + " ";
            }
        });
        log('Extracted', entries.length, 'entries,', transcriptText.length, 'chars');

        if (!transcriptText.trim()) {
            console.error("No transcript text extracted.");
            updateButtonText("Transcript Not Found");
            copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            if (cleanupCallback) cleanupCallback();
            return;
        }

        navigator.clipboard.writeText(transcriptText)
            .then(() => {
              updateButtonText("Copied!");
              if (cleanupCallback) cleanupCallback();
            })
            .catch(err => {
                console.error('Failed to copy transcript:', err);
                if (copyButton) {
                    updateButtonText("Copy Failed");
                    copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
                }
                if (cleanupCallback) cleanupCallback();
            });
    }

    function updateButtonText(text) {
        if (copyButton && buttonTextNode) {
            buttonTextNode.textContent = text;
            if (text === "Copied!") {
                copyButton.style.backgroundColor = "rgba(40, 167, 69, 0.9)";
                  setTimeout(() => {
                        if (buttonTextNode) buttonTextNode.textContent = 'Copy Transcript';
                        if (copyButton) copyButton.style.backgroundColor = 'rgba(0, 123, 255, 0.8)';
                    }, 1500);
            } else if (text.startsWith("Error") || text === "Copy Failed" || text === "Transcript Not Found") {
                 copyButton.style.backgroundColor = "rgba(220, 53, 69, 0.8)";
            }
        }
    }

    function injectStyles() {
        if (document.getElementById('yt-transcript-button-styles')) return;

        const style = document.createElement('style');
        style.id = 'yt-transcript-button-styles';
        style.textContent = `
            .yt-transcript-button {
                background-color: rgba(0, 123, 255, 0.8);
                border: none;
                color: white;
                padding: 10px 18px;
                text-align: center;
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                font-size: 15px;
                margin: 4px 2px;
                cursor: pointer;
                border-radius: 24px;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                font-family: 'Roboto', sans-serif;
                font-weight: 500;
                position: relative;
                overflow: hidden;
            }

            .yt-transcript-button:hover {
                background-color: rgba(0, 90, 180, 0.9);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                transform: translateY(-1px);
            }

            .yt-transcript-button:focus {
                outline: none;
                box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.3);
            }
        `;
        document.head.appendChild(style);
    }

    function attemptButtonCreation() {
        if (createTranscriptButton()) {
            clearInterval(retryInterval);
            retryInterval = null;
        }
    }

    function resetState() {
        const button = document.getElementById('show-transcript-button');
        if (button) {
            button.remove();
        }
        if (retryInterval) {
            clearInterval(retryInterval);
            retryInterval = null;
        }
        clearTimeout(transcriptPanelTimeout);
        clearTimeout(transcriptButtonTimeout);
        copyButton = null;
        buttonTextNode = null;
    }

})();
