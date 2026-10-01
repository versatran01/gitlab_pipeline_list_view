/* global importScripts, syncInstanceScripts */
importScripts('instances.js');

chrome.runtime.onInstalled.addListener(syncInstanceScripts);
chrome.runtime.onStartup.addListener(syncInstanceScripts);
