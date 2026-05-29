/**
 * OMR Scanner Web App — Main Application Controller
 *
 * State machine: LOADING → SCANNING → REVIEW → SCANNING
 * Port of the live_scanner.py main loop with camera management,
 * AR overlay, capture, and results display.
 */

import { loadTemplate, getConcatenatedResponse } from "./template_parser.js";
import {
  detectAnchors,
  smoothPoints,
  readOmrResponse,
  projectBubblesOnFrame,
  drawAnchorBox,
  getTemplateAnchorsMat,
  anchorPointsToMat,
  warpToFlat,
} from "./cv_engine.js";

// ─── Template Configuration ─────────────────────────────────────────────────

const TEMPLATE_CONFIG = {
  finder: { url: "/templates/Template_Finder.json", label: "Finder (Auto-Detect)" },
  pvm: { url: "/templates/Template_PVM.json", label: "PVM (40Q + Paper Code)" },
  dt40: { url: "/templates/Template_DT_40.json", label: "DT-40 (40 Questions)" },
  dt50: { url: "/templates/Template_DT_50.json", label: "DT-50 (50 Questions)" },
};

// ─── Main App Class ─────────────────────────────────────────────────────────

export class OMRApp {
  constructor() {
    this.state = "LOADING";
    this.templates = {};
    this.activeTemplate = null;
    this.finderTemplate = null;
    this.anchorHistory = null;
    this.stream = null;
    this.animFrameId = null;
    this.lastResults = null;

    // DOM elements (populated in init)
    this.video = null;
    this.liveCanvas = null;
    this.liveCtx = null;
    this.reviewCanvas = null;
    this.hiddenCanvas = null;
    this.hiddenCtx = null;
  }

  // ─── Initialization ─────────────────────────────────────────────────────

  async init() {
    this.bindDOM();
    this.bindEvents();
    this.updateStatus("Loading templates...", "loading");

    try {
      // Load all templates
      await this.loadAllTemplates();
      this.updateStatus("Templates loaded. Starting camera...", "loading");

      // Enumerate cameras and prefer external
      await this.setupCamera();

      this.state = "SCANNING";
      this.updateStatus("Searching for 4 corner markers...", "searching");
      this.updateUIForState();

      // Start processing loop
      this.processFrame();
    } catch (err) {
      console.error("Init error:", err);
      this.updateStatus(`Error: ${err.message}`, "error");
    }
  }

  bindDOM() {
    this.video = document.getElementById("camera-video");
    this.liveCanvas = document.getElementById("live-canvas");
    this.liveCtx = this.liveCanvas.getContext("2d");
    this.reviewCanvas = document.getElementById("review-canvas");
    this.hiddenCanvas = document.getElementById("hidden-canvas");
    this.hiddenCtx = this.hiddenCanvas.getContext("2d", { willReadFrequently: true });

    this.statusBar = document.getElementById("status-bar");
    this.statusText = document.getElementById("status-text");
    this.statusDot = document.getElementById("status-dot");
    this.templateSelect = document.getElementById("template-select");
    this.cameraSelect = document.getElementById("camera-select");
    this.captureBtn = document.getElementById("capture-btn");
    this.approveBtn = document.getElementById("approve-btn");
    this.retakeBtn = document.getElementById("retake-btn");
    this.exportBtn = document.getElementById("export-btn");
    this.resultsBody = document.getElementById("results-body");
    this.scanPanel = document.getElementById("scan-panel");
    this.reviewPanel = document.getElementById("review-panel");
    this.resultsPanel = document.getElementById("results-panel");
    this.loadingOverlay = document.getElementById("loading-overlay");

    // New mobile UI elements
    this.settingsToggle = document.getElementById("settings-toggle");
    this.settingsDrawer = document.getElementById("settings-drawer");
    this.resultsHandle = document.getElementById("results-handle");
  }

  bindEvents() {
    // Capture button + spacebar
    this.captureBtn.addEventListener("click", () => this.capture());
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && this.state === "SCANNING" && this.anchorHistory) {
        e.preventDefault();
        this.capture();
      }
      if (e.code === "KeyN" && this.state === "REVIEW") {
        this.retake();
      }
      if (e.code === "KeyY" && this.state === "REVIEW") {
        this.approve();
      }
    });

    // Review buttons
    this.approveBtn.addEventListener("click", () => this.approve());
    this.retakeBtn.addEventListener("click", () => this.retake());

    // Export
    this.exportBtn.addEventListener("click", () => this.exportCSV());

    // Template change
    this.templateSelect.addEventListener("change", (e) => {
      this.switchTemplate(e.target.value);
    });

    // Camera change
    this.cameraSelect.addEventListener("change", (e) => {
      this.switchCamera(e.target.value);
    });

    // Settings drawer toggle
    this.settingsToggle.addEventListener("click", () => {
      this.settingsDrawer.classList.toggle("open");
      this.settingsToggle.classList.toggle("active");
    });

    // Results drawer — tap handle to collapse
    if (this.resultsHandle) {
      this.resultsHandle.addEventListener("click", () => {
        this.resultsPanel.classList.toggle("active");
      });
    }
  }

  // ─── Template Loading ───────────────────────────────────────────────────

  async loadAllTemplates() {
    const entries = Object.entries(TEMPLATE_CONFIG);
    for (const [key, config] of entries) {
      try {
        this.templates[key] = await loadTemplate(config.url);
        console.log(`Loaded template: ${config.label}`);
      } catch (err) {
        console.error(`Failed to load template ${key}:`, err);
      }
    }

    this.finderTemplate = this.templates.finder || null;
    // Default to PVM template
    this.activeTemplate = this.templates.pvm || Object.values(this.templates)[0];

    // Populate template selector
    for (const [key, config] of entries) {
      if (key === "finder") continue; // Don't show finder in selector
      if (this.templates[key]) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = config.label;
        if (key === "pvm") option.selected = true;
        this.templateSelect.appendChild(option);
      }
    }
  }

  switchTemplate(key) {
    if (this.templates[key]) {
      this.activeTemplate = this.templates[key];
      this.anchorHistory = null;
      console.log(`Switched to template: ${TEMPLATE_CONFIG[key].label}`);
    }
  }

  // ─── Camera Management ──────────────────────────────────────────────────

  async setupCamera() {
    // First get permission with basic constraints
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      tempStream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      throw new Error("Camera permission denied. Please allow camera access.");
    }

    // Enumerate devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter((d) => d.kind === "videoinput");

    if (videoDevices.length === 0) {
      throw new Error("No camera found.");
    }

    // Populate camera selector
    this.cameraSelect.innerHTML = "";
    videoDevices.forEach((device, idx) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent =
        device.label || `Camera ${idx + 1}`;
      this.cameraSelect.appendChild(option);
    });

    // Prefer external camera (last device, or one with "external"/"USB" in name)
    let preferredIdx = videoDevices.length - 1; // Default: last = usually external
    for (let i = 0; i < videoDevices.length; i++) {
      const label = (videoDevices[i].label || "").toLowerCase();
      if (
        label.includes("external") ||
        label.includes("usb") ||
        label.includes("webcam")
      ) {
        preferredIdx = i;
        break;
      }
    }

    this.cameraSelect.selectedIndex = preferredIdx;
    await this.startCamera(videoDevices[preferredIdx].deviceId);
  }

  async startCamera(deviceId) {
    // Stop existing stream
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    this.video.srcObject = this.stream;
    await this.video.play();

    // Set canvas dimensions to match video
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    this.liveCanvas.width = vw;
    this.liveCanvas.height = vh;
    this.hiddenCanvas.width = vw;
    this.hiddenCanvas.height = vh;

    console.log(`Camera started: ${vw}×${vh}`);
  }

  async switchCamera(deviceId) {
    this.anchorHistory = null;
    await this.startCamera(deviceId);
  }

  // ─── Frame Processing Loop ─────────────────────────────────────────────

  processFrame() {
    if (this.state !== "SCANNING") {
      this.animFrameId = requestAnimationFrame(() => this.processFrame());
      return;
    }

    if (this.video.readyState < 2) {
      this.animFrameId = requestAnimationFrame(() => this.processFrame());
      return;
    }

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;

    // Draw video to hidden canvas
    this.hiddenCtx.drawImage(this.video, 0, 0, vw, vh);
    const imageData = this.hiddenCtx.getImageData(0, 0, vw, vh);

    // Create OpenCV Mat from ImageData
    let src = cv.matFromImageData(imageData);

    // Detect anchors
    const rawAnchors = detectAnchors(src);

    if (rawAnchors !== null) {
      // Smooth points with EMA
      this.anchorHistory = smoothPoints(rawAnchors, this.anchorHistory);

      // Draw anchor bounding box
      drawAnchorBox(src, this.anchorHistory);

      // AR overlay: project template bubbles onto live feed
      if (this.activeTemplate) {
        try {
          const templateAnchorsMat = getTemplateAnchorsMat(this.activeTemplate);
          const liveAnchorsMat = anchorPointsToMat(this.anchorHistory);
          const liveMatrix = cv.getPerspectiveTransform(
            templateAnchorsMat,
            liveAnchorsMat
          );

          projectBubblesOnFrame(src, this.activeTemplate, liveMatrix);

          templateAnchorsMat.delete();
          liveAnchorsMat.delete();
          liveMatrix.delete();
        } catch (e) {
          // Ignore transient projection errors
        }
      }

      this.updateStatus("ANCHORS LOCKED — Press SPACE or CAPTURE", "locked");
      this.captureBtn.disabled = false;
      this.liveCanvas.classList.add("anchors-locked");
    } else {
      this.anchorHistory = null;
      this.updateStatus("Searching for 4 corner markers...", "searching");
      this.captureBtn.disabled = true;
      this.liveCanvas.classList.remove("anchors-locked");
    }

    // Display result on live canvas
    cv.imshow(this.liveCanvas, src);
    src.delete();

    this.animFrameId = requestAnimationFrame(() => this.processFrame());
  }

  // ─── Capture & Process ──────────────────────────────────────────────────

  capture() {
    if (!this.anchorHistory || !this.activeTemplate) return;

    this.updateStatus("Capturing & Processing...", "processing");

    // Get current frame
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    this.hiddenCtx.drawImage(this.video, 0, 0, vw, vh);
    const imageData = this.hiddenCtx.getImageData(0, 0, vw, vh);
    const frameMat = cv.matFromImageData(imageData);

    try {
      // Warp to flat grayscale (port of live_scanner.py L128-134)
      const grayFlat = warpToFlat(frameMat, this.anchorHistory, this.activeTemplate);

      // Run the OMR reading engine (port of core.py read_omr_response)
      const result = readOmrResponse(this.activeTemplate, grayFlat);

      // Get concatenated response
      const finalResponse = getConcatenatedResponse(
        result.omrResponse,
        this.activeTemplate
      );

      this.lastResults = {
        raw: result.omrResponse,
        concatenated: finalResponse,
        multiMarked: result.multiMarked,
      };

      // Display review image
      this.reviewCanvas.width = result.finalMarked.cols;
      this.reviewCanvas.height = result.finalMarked.rows;
      cv.imshow(this.reviewCanvas, result.finalMarked);

      // Display results table
      this.displayResults(finalResponse, result.multiMarked);

      // Switch to REVIEW state
      this.state = "REVIEW";
      this.updateStatus(
        "REVIEW: 'Y' to Approve, 'N' to Retake",
        "review"
      );
      this.updateUIForState();

      // Cleanup
      result.finalMarked.delete();
      grayFlat.delete();

      console.log("─── CAPTURE RESULTS ───");
      console.log(finalResponse);
    } catch (err) {
      console.error("Processing error:", err);
      this.updateStatus(`Processing error: ${err.message}`, "error");
    }

    frameMat.delete();
  }

  // ─── Review Actions ─────────────────────────────────────────────────────

  approve() {
    console.log("Approved! Data saved.");
    this.state = "SCANNING";
    this.anchorHistory = null;
    this.updateStatus("Approved! Scanning for next sheet...", "searching");
    this.updateUIForState();
  }

  retake() {
    this.state = "SCANNING";
    this.anchorHistory = null;
    this.lastResults = null;
    this.updateStatus("Retaking — Searching for markers...", "searching");
    this.updateUIForState();
  }

  // ─── Results Display ────────────────────────────────────────────────────

  displayResults(response, multiMarked) {
    this.resultsBody.innerHTML = "";

    // Show/hide multi-marked warning banner at top
    const banner = document.getElementById("multi-marked-banner");
    if (banner) {
      banner.classList.toggle("hidden", !multiMarked);
    }

    // ─── Group numbered fields for combined display ───
    // Collect paper_code1, paper_code2, ... → "Paper Code"
    // Collect roll1, roll2, ..., roll13 → "Roll No"
    const paperCodeParts = [];
    const rollParts = [];
    const otherEntries = [];

    for (const [key, value] of Object.entries(response)) {
      const paperMatch = key.match(/^paper_code(\d+)$/);
      const rollMatch = key.match(/^roll(\d+)$/);

      if (paperMatch) {
        paperCodeParts.push({ idx: parseInt(paperMatch[1], 10), value: value || "" });
      } else if (rollMatch) {
        rollParts.push({ idx: parseInt(rollMatch[1], 10), value: value || "" });
      } else {
        otherEntries.push([key, value]);
      }
    }

    // Sort by index and concatenate
    paperCodeParts.sort((a, b) => a.idx - b.idx);
    rollParts.sort((a, b) => a.idx - b.idx);

    const combinedPaperCode = paperCodeParts.map(p => p.value).join("");
    const combinedRoll = rollParts.map(p => p.value).join("");

    // Build display entries — combined fields first, then others sorted
    const displayEntries = [];

    if (rollParts.length > 0) {
      displayEntries.push(["Roll No", combinedRoll]);
    }
    if (paperCodeParts.length > 0) {
      displayEntries.push(["Paper Code", combinedPaperCode]);
    }

    // Sort remaining entries naturally
    otherEntries.sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" })
    );
    displayEntries.push(...otherEntries);

    // Render table rows
    for (const [key, value] of displayEntries) {
      const row = document.createElement("tr");

      const keyCell = document.createElement("td");
      keyCell.textContent = key;

      const valueCell = document.createElement("td");
      valueCell.textContent = value || "—";
      if (!value || value === "") {
        valueCell.classList.add("empty-value");
      }

      row.appendChild(keyCell);
      row.appendChild(valueCell);
      this.resultsBody.appendChild(row);
    }
  }

  // ─── CSV Export ─────────────────────────────────────────────────────────

  exportCSV() {
    if (!this.lastResults) return;

    const response = this.lastResults.concatenated;
    const headers = Object.keys(response);
    const values = Object.values(response).map((v) =>
      v === undefined || v === null ? "" : String(v)
    );

    const csvContent = [headers.join(","), values.join(",")].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `omr_result_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ─── UI Helpers ─────────────────────────────────────────────────────────

  updateStatus(text, statusClass) {
    this.statusText.textContent = text;
    this.statusBar.className = `status-pill ${statusClass}`;
  }

  updateUIForState() {
    const isScanning = this.state === "SCANNING";
    const isReview = this.state === "REVIEW";

    // Action panels
    this.scanPanel.classList.toggle("active", isScanning);
    this.reviewPanel.classList.toggle("active", isReview);

    // Results drawer
    this.resultsPanel.classList.toggle("active", isReview);

    // Canvas visibility
    this.liveCanvas.classList.toggle("hidden", isReview);
    this.reviewCanvas.classList.toggle("hidden", isScanning);
    this.loadingOverlay.classList.toggle("hidden", this.state !== "LOADING");

    // Button visibility
    this.captureBtn.classList.toggle("hidden", isReview);
    this.approveBtn.classList.toggle("hidden", isScanning);
    this.retakeBtn.classList.toggle("hidden", isScanning);
    this.exportBtn.classList.toggle("hidden", isScanning || !this.lastResults);

    // Close settings drawer when scanning
    if (isScanning) {
      this.settingsDrawer.classList.remove("open");
      this.settingsToggle.classList.remove("active");
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  destroy() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
  }
}
