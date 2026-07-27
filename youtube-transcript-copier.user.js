// ==UserScript==
// @name         YouTube Transcript Copier (Optimized SPA Version)
// @match        https://www.youtube.com/*
// @grant        none
// @version      1.3
// @author       Amir Tehrani
// @description  Adds a styled button to copy the YouTube video transcript, with a timestamp toggle. Works on playlist pages, soft-navigation, and new 2026 "modern transcript view" panel.
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
    // Panel / segment detection (supports BOTH old and new layouts)
    // ---------------------------------------------------------------

    // Old layout: ytd-transcript-segment-renderer inside
    //   ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]
    // New layout (2026 "modern transcript view"): transcript-segment-view-model inside
    //   ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]

    const PANEL_SELECTORS = [
        'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"] #content',
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #content'
    ];

    const SEGMENT_SELECTOR = 'transcript-segment-view-model, ytd-transcript-segment-renderer';

    // Returns the panel content element that actually contains loaded segments, or null
    function findLoadedTranscriptPanel() {
        for (const selector of PANEL_SELECTORS) {
            const panel = document.querySelector(selector);
            if (panel && panel.querySelector(SEGMENT_SELECTOR)) {
                return panel;
            }
        }
        return null;
    }

    // Extracts { timestamp, text } from a segment element of either layout
    function extractSegmentData(segment) {
        if (segment.tagName.toLowerCase() === 'transcript-segment-view-model') {
            // New layout
            const timestampElement = segment.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
            const textElement = segment.querySelector('.ytAttributedStringHost, span[role="text"]');
            return {
                timestamp: timestampElement ? timestampElement.textContent.trim() : '',
                text: textElement ? textElement.textContent.trim() : ''
            };
        }
        // Old layout
        const timestampElement = segment.querySelector('.segment-timestamp');
        const textElement = segment.querySelector('.segment-text');
        return {
            timestamp: timestampElement ? timestampElement.textContent.trim() : '',
            text: textElement ? textElement.textContent.trim() : ''
        };
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
        // Robust list of potential targets to handle different YouTube layouts (e.g., playlist vs. standard).
        const potentialTargets = [
            '#owner', // Reliable on both layouts, next to channel info
            '#above-the-fold #actions-inner', // Reliable on both layouts, inside like/share container
            '#top-row.ytd-watch-metadata', // Reliable fallback
            '#meta-contents', // Original target, works on non-playlist pages
            '#above-the-fold' // Final fallback
        ];

        for (const targetSelector of potentialTargets) {
            const targetElement = document.querySelector(targetSelector);
            // Check if the element exists AND is visible before inserting the button.
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

        // Function will be called to restore the UI to its original state
        function cleanupUI() {
            if (playlistPanel) {
                playlistPanel.style.display = ''; // Restore playlist visibility
            }
        }

        // On playlist pages, the playlist panel conflicts with the transcript panel
        // Temporarily hide it to allow the transcript to load
        if (playlistPanel) {
            playlistPanel.style.display = 'none';
        }

        // Fast path: if a transcript panel is already open and loaded, copy immediately.
        const alreadyLoadedPanel = findLoadedTranscriptPanel();
        if (alreadyLoadedPanel) {
            copyTranscriptText(alreadyLoadedPanel, cleanupUI);
            return;
        }

        // The "Show transcript" button lives in the description's transcript section.
        // Try it directly first; fall back to opening the "More actions" menu (old flow).
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

        let transcriptText = "";
        const segments = transcriptPanel.querySelectorAll(SEGMENT_SELECTOR);

        segments.forEach(segment => {
            const { timestamp, text } = extractSegmentData(segment);
            if (!text) return;
            if (includeTimestamps) {
                transcriptText += (timestamp ? timestamp + " " : "") + text + "\n";
            } else {
                transcriptText += text + " ";
            }
        });

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
