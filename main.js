/**
 * OMR Scanner Web App — Entry Point
 *
 * Waits for OpenCV.js to initialize, then boots the OMR application.
 */

import './style.css';
import { OMRApp } from './app.js';

let app = null;

function onOpenCvReady() {
  console.log('OpenCV.js initialized. Starting OMR Scanner...');

  // Update loading text
  const loadingText = document.querySelector('.loading-text');
  if (loadingText) {
    loadingText.textContent = 'Initializing scanner...';
  }

  // Create and start the app
  app = new OMRApp();
  app.init();
}

// Listen for OpenCV.js readiness
document.addEventListener('opencv-ready', onOpenCvReady);

// Fallback: check if cv is already loaded (race condition)
if (typeof cv !== 'undefined' && cv.Mat) {
  onOpenCvReady();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (app) {
    app.destroy();
  }
});
