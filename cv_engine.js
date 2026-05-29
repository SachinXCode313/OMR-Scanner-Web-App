/**
 * CV Engine — Exact port of:
 *   live_scanner.py: detect_anchors(), smooth_points()
 *   src/core.py: ImageInstanceOps.read_omr_response(),
 *                get_global_threshold(), get_local_threshold()
 *   src/utils/image.py: normalize, gamma adjust, CLAHE
 *
 * Uses OpenCV.js (global `cv` object).
 * Every algorithm is ported line-by-line to ensure identical accuracy.
 */

import {
  CONFIG_DEFAULTS,
  GLOBAL_PAGE_THRESHOLD_WHITE,
  GLOBAL_PAGE_THRESHOLD_BLACK,
} from "./template_parser.js";

// ─── Math Helpers ───────────────────────────────────────────────────────────

function std(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function roundTo(val, decimals) {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

// ─── Image Utilities (port of src/utils/image.py) ───────────────────────────

/**
 * Port of ImageUtils.adjust_gamma()
 * Builds a LUT and applies gamma correction.
 */
function adjustGamma(src, dst, gamma) {
  const invGamma = 1.0 / gamma;
  const lut = new cv.Mat(1, 256, cv.CV_8UC1);
  for (let i = 0; i < 256; i++) {
    lut.data[i] = Math.min(
      255,
      Math.max(0, Math.round(Math.pow(i / 255.0, invGamma) * 255))
    );
  }
  cv.LUT(src, lut, dst);
  lut.delete();
}

/**
 * Port of ImageUtils.normalize_util()
 * Normalizes to [0, 255] range using NORM_MINMAX.
 */
function normalizeImage(src, dst) {
  cv.normalize(src, dst, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
}

/**
 * Apply CLAHE with fallback to equalizeHist if CLAHE is unavailable.
 */
function applyCLAHE(src, dst, clipLimit, tileSize) {
  try {
    const clahe = cv.createCLAHE(clipLimit, new cv.Size(tileSize, tileSize));
    clahe.apply(src, dst);
    clahe.delete();
  } catch (e) {
    // Fallback: simple histogram equalization
    cv.equalizeHist(src, dst);
  }
}

// ─── Anchor Detection (port of live_scanner.py L11-47 & L187-219) ───────────

/**
 * Detect 4 dark anchor markers and return their centers ordered as:
 * [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
 *
 * EXACT port of detect_anchors() from live_scanner.py
 *
 * @param {cv.Mat} frameMat - RGBA frame from camera
 * @returns {Array<[number,number]>|null} - 4 ordered anchor points or null
 */
export function detectAnchors(frameMat) {
  let gray = new cv.Mat();
  cv.cvtColor(frameMat, gray, cv.COLOR_RGBA2GRAY);

  let thresh = new cv.Mat();
  // Exact params from Python: adaptiveThreshold(gray, 255, ADAPTIVE_THRESH_GAUSSIAN_C, THRESH_BINARY_INV, 21, 10)
  cv.adaptiveThreshold(
    gray,
    thresh,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV,
    21,
    10
  );

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  // Exact: findContours(thresh, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)
  cv.findContours(
    thresh,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );

  const candidates = [];

  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);

    // Exact filter: 200 < area < 8000
    if (area > 200 && area < 8000) {
      const rect = cv.boundingRect(c);
      const aspectRatio = rect.width / rect.height;

      // Exact filter: 0.7 <= aspect_ratio <= 1.3
      if (aspectRatio >= 0.7 && aspectRatio <= 1.3) {
        const M = cv.moments(c);
        if (M.m00 !== 0) {
          const cx = Math.round(M.m10 / M.m00);
          const cy = Math.round(M.m01 / M.m00);
          candidates.push([cx, cy]);
        }
      }
    }
  }

  // Cleanup
  gray.delete();
  thresh.delete();
  contours.delete();
  hierarchy.delete();

  if (candidates.length >= 4) {
    // Order points exactly like Python:
    // sum = x + y; diff = y - x (np.diff on axis=1 computes col[1]-col[0])
    const sums = candidates.map((p) => p[0] + p[1]);
    const diffs = candidates.map((p) => p[1] - p[0]);

    const ordered = new Array(4);

    // TL: min sum (smallest x+y)
    let minSumIdx = 0;
    for (let i = 1; i < sums.length; i++) {
      if (sums[i] < sums[minSumIdx]) minSumIdx = i;
    }
    ordered[0] = candidates[minSumIdx];

    // TR: min diff (smallest y-x, i.e. large x, small y)
    let minDiffIdx = 0;
    for (let i = 1; i < diffs.length; i++) {
      if (diffs[i] < diffs[minDiffIdx]) minDiffIdx = i;
    }
    ordered[1] = candidates[minDiffIdx];

    // BR: max sum (largest x+y)
    let maxSumIdx = 0;
    for (let i = 1; i < sums.length; i++) {
      if (sums[i] > sums[maxSumIdx]) maxSumIdx = i;
    }
    ordered[2] = candidates[maxSumIdx];

    // BL: max diff (largest y-x, i.e. small x, large y)
    let maxDiffIdx = 0;
    for (let i = 1; i < diffs.length; i++) {
      if (diffs[i] > diffs[maxDiffIdx]) maxDiffIdx = i;
    }
    ordered[3] = candidates[maxDiffIdx];

    return ordered;
  }

  return null;
}

// ─── EMA Smoothing (port of live_scanner.py L49-51) ─────────────────────────

/**
 * Exponential Moving Average smoothing for anchor point stabilization.
 * Exact port: current * alpha + history * (1 - alpha)
 *
 * @param {Array<[number,number]>} current - Current frame's anchor points
 * @param {Array<[number,number]>|null} history - Previous smoothed points
 * @param {number} alpha - Smoothing factor (default 0.15)
 * @returns {Array<[number,number]>} Smoothed points
 */
export function smoothPoints(current, history, alpha = 0.15) {
  if (history === null) return current.map((p) => [...p]);
  return current.map((p, i) => [
    p[0] * alpha + history[i][0] * (1.0 - alpha),
    p[1] * alpha + history[i][1] * (1.0 - alpha),
  ]);
}

// ─── Global Threshold (EXACT port of core.py L513-614) ──────────────────────

/**
 * Find the "first large gap" threshold.
 *
 * The algorithm sorts all values, then scans for the largest jump
 * between values separated by `looseness` positions. This naturally
 * separates marked (dark) bubbles from unmarked (light) ones.
 *
 * @param {number[]} qValsOrig - Array of bubble mean intensities or std-devs
 * @param {number} looseness - Controls the window size for gap detection (default 1)
 * @returns {[number, number, number]} [globalThr, jLow, jHigh]
 */
export function getGlobalThreshold(qValsOrig, looseness = 1) {
  const config = CONFIG_DEFAULTS.threshold_params;
  const PAGE_TYPE = config.PAGE_TYPE_FOR_THRESHOLD;
  const MIN_JUMP = config.MIN_JUMP;
  const JUMP_DELTA = config.JUMP_DELTA;

  const globalDefaultThreshold =
    PAGE_TYPE === "white"
      ? GLOBAL_PAGE_THRESHOLD_WHITE
      : GLOBAL_PAGE_THRESHOLD_BLACK;

  // Sort the Q bubbleValues (exact: q_vals = sorted(q_vals_orig))
  const qVals = [...qValsOrig].sort((a, b) => a - b);

  // Find the FIRST LARGE GAP
  // Exact: ls = (looseness + 1) // 2
  const ls = Math.floor((looseness + 1) / 2);
  const l = qVals.length - ls;
  let max1 = MIN_JUMP;
  let thr1 = globalDefaultThreshold;

  for (let i = ls; i < l; i++) {
    const jump = qVals[i + ls] - qVals[i - ls];
    if (jump > max1) {
      max1 = jump;
      thr1 = qVals[i - ls] + jump / 2;
    }
  }

  // thr2 (deprecated but still computed for completeness)
  let max2 = MIN_JUMP;
  let thr2 = globalDefaultThreshold;
  for (let i = ls; i < l; i++) {
    const jump = qVals[i + ls] - qVals[i - ls];
    const newThr = qVals[i - ls] + jump / 2;
    if (jump > max2 && Math.abs(thr1 - newThr) > JUMP_DELTA) {
      max2 = jump;
      thr2 = newThr;
    }
  }

  const globalThr = thr1;
  const jLow = thr1 - Math.floor(max1 / 2);
  const jHigh = thr1 + Math.floor(max1 / 2);

  return [globalThr, jLow, jHigh];
}

// ─── Local Threshold (EXACT port of core.py L616-715) ───────────────────────

/**
 * Per question-strip local threshold.
 *
 * Sorts bubble values within a strip, finds the largest gap,
 * and decides if the local gap is confident enough or should
 * fall back to the global threshold.
 *
 * @param {number[]} qValsOrig - Bubble intensities for this strip
 * @param {number} globalThr - Global threshold from getGlobalThreshold
 * @param {boolean} noOutliers - Whether this strip has low std-dev
 * @returns {number} The threshold for this strip
 */
export function getLocalThreshold(qValsOrig, globalThr, noOutliers) {
  const config = CONFIG_DEFAULTS.threshold_params;
  const MIN_GAP = config.MIN_GAP;
  const MIN_JUMP = config.MIN_JUMP;
  const CONFIDENT_SURPLUS = config.CONFIDENT_SURPLUS;

  // Sort the Q bubbleValues
  const qVals = [...qValsOrig].sort((a, b) => a - b);
  let thr1;

  // Exact: base case: 1 or 2 pts
  if (qVals.length < 3) {
    thr1 =
      Math.max(...qVals) - Math.min(...qVals) < MIN_GAP
        ? globalThr
        : mean(qVals);
  } else {
    // Find the LARGEST GAP
    const l = qVals.length - 1;
    let max1 = MIN_JUMP;
    thr1 = 255;

    for (let i = 1; i < l; i++) {
      const jump = qVals[i + 1] - qVals[i - 1];
      if (jump > max1) {
        max1 = jump;
        thr1 = qVals[i - 1] + jump / 2;
      }
    }

    // If not confident, take help of global_thr
    const confidentJump = MIN_JUMP + CONFIDENT_SURPLUS; // 14
    if (max1 < confidentJump) {
      if (noOutliers) {
        // All Black or All White case — use global threshold
        thr1 = globalThr;
      }
      // else: low confidence parameters (TODO in original code too)
    }
  }

  return thr1;
}

// ─── Read OMR Response (EXACT port of core.py L46-446) ──────────────────────

/**
 * The main OMR reading engine. Processes a flattened grayscale image
 * against a template to detect marked bubbles.
 *
 * EXACT port of ImageInstanceOps.read_omr_response() from core.py
 *
 * @param {object} template - Template instance with fieldBlocks
 * @param {cv.Mat} grayImageMat - Grayscale flattened paper image
 * @returns {{ omrResponse: object, finalMarked: cv.Mat, multiMarked: boolean }}
 */
export function readOmrResponse(template, grayImageMat) {
  const config = CONFIG_DEFAULTS;
  const autoAlign = config.alignment_params.auto_align;

  // ── Step 1: Resize to template dimensions ──
  const tw = template.pageDimensions[0];
  const th = template.pageDimensions[1];
  let img = new cv.Mat();
  const dsize = new cv.Size(tw, th);
  cv.resize(grayImageMat, img, dsize, 0, 0, cv.INTER_LINEAR);

  // ── Step 2: Normalize if needed ──
  const minMax = cv.minMaxLoc(img);
  if (minMax.maxVal > minMax.minVal) {
    normalizeImage(img, img);
  }

  // ── Processing copies ──
  const transpLayer = img.clone();
  let finalMarked = img.clone();
  let morph = img.clone();

  // ── Step 3: Auto-alignment ──
  if (autoAlign) {
    // 3a. CLAHE (clipLimit=5.0, tileGridSize=8×8) — port of CLAHE_HELPER
    applyCLAHE(morph, morph, 5.0, 8);

    // 3b. Gamma adjustment (0.75) — port of adjust_gamma
    adjustGamma(morph, morph, config.threshold_params.GAMMA_LOW);

    // 3c. Threshold truncate at 220
    cv.threshold(morph, morph, 220, 220, cv.THRESH_TRUNC);

    // 3d. Normalize
    normalizeImage(morph, morph);

    // 3e. Vertical morphological open: kernel (2,10), 3 iterations
    const vKernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(2, 10)
    );
    let morphV = new cv.Mat();
    cv.morphologyEx(
      morph,
      morphV,
      cv.MORPH_OPEN,
      vKernel,
      new cv.Point(-1, -1),
      3
    );

    // 3f. Threshold truncate at 200
    cv.threshold(morphV, morphV, 200, 200, cv.THRESH_TRUNC);

    // 3g. Invert & Normalize: 255 - normalize(morphV)
    normalizeImage(morphV, morphV);
    cv.bitwise_not(morphV, morphV);

    // 3h. Binary threshold at 60
    cv.threshold(morphV, morphV, 60, 255, cv.THRESH_BINARY);

    // 3i. Erode with (5,5) kernel, 2 iterations
    const erodeKernel = cv.Mat.ones(5, 5, cv.CV_8U);
    cv.erode(morphV, morphV, erodeKernel, new cv.Point(-1, -1), 2);
    erodeKernel.delete();

    // 3j. Column shift detection per field block
    // Exact port of core.py L136-197
    const matchCol = config.alignment_params.match_col;
    const maxSteps = config.alignment_params.max_steps;
    const alignStride = config.alignment_params.stride;
    const thk = config.alignment_params.thickness;

    for (const fieldBlock of template.fieldBlocks) {
      const s = fieldBlock.origin;
      const d = fieldBlock.dimensions;
      let shift = 0;
      let steps = 0;

      while (steps < maxSteps) {
        // Left ROI: morph_v[s[1]:s[1]+d[1], s[0]+shift-thk : s[0]+shift-thk+matchCol]
        const leftX = s[0] + shift - thk;
        const leftW = matchCol;
        const roiY = s[1];
        const roiH = d[1];

        // Right ROI: morph_v[s[1]:s[1]+d[1], s[0]+shift-matchCol+d[0]+thk : s[0]+shift+d[0]+thk]
        const rightX = s[0] + shift - matchCol + d[0] + thk;
        const rightW = matchCol;

        // Bounds checking
        if (
          leftX < 0 ||
          leftX + leftW > morphV.cols ||
          rightX < 0 ||
          rightX + rightW > morphV.cols ||
          roiY < 0 ||
          roiY + roiH > morphV.rows
        ) {
          break;
        }

        const leftRoi = morphV.roi(
          new cv.Rect(leftX, roiY, leftW, roiH)
        );
        const leftMean = cv.mean(leftRoi)[0];
        leftRoi.delete();

        const rightRoi = morphV.roi(
          new cv.Rect(rightX, roiY, rightW, roiH)
        );
        const rightMean = cv.mean(rightRoi)[0];
        rightRoi.delete();

        const leftShift = leftMean > 100;
        const rightShift = rightMean > 100;

        if (leftShift) {
          if (rightShift) {
            break;
          } else {
            shift -= alignStride;
          }
        } else {
          if (rightShift) {
            shift += alignStride;
          } else {
            break;
          }
        }
        steps++;
      }
      fieldBlock.shift = shift;
    }

    vKernel.delete();
    morphV.delete();
  }
  morph.delete();

  // ── Step 4: Collect bubble mean intensities ──
  // Exact port of core.py L214-238
  const allQVals = [];
  const allQStripArrs = [];
  const allQStdVals = [];

  for (const fieldBlock of template.fieldBlocks) {
    const [boxW, boxH] = fieldBlock.bubbleDimensions;
    const qStdVals = [];

    for (const fieldBlockBubbles of fieldBlock.traverseBubbles) {
      const qStripVals = [];

      for (const pt of fieldBlockBubbles) {
        // Apply alignment shift to x coordinate
        const x = Math.round(pt.x + fieldBlock.shift);
        const y = Math.round(pt.y);

        // Bounds check for ROI
        const roiX = Math.max(0, Math.min(x, img.cols - boxW));
        const roiY = Math.max(0, Math.min(y, img.rows - boxH));
        const roiW = Math.min(boxW, img.cols - roiX);
        const roiH = Math.min(boxH, img.rows - roiY);

        if (roiW > 0 && roiH > 0) {
          const roi = img.roi(new cv.Rect(roiX, roiY, roiW, roiH));
          const meanVal = cv.mean(roi)[0];
          roi.delete();
          qStripVals.push(meanVal);
        } else {
          qStripVals.push(255); // Default to white (unmarked)
        }
      }

      qStdVals.push(roundTo(std(qStripVals), 2));
      allQStripArrs.push([...qStripVals]);
      allQVals.push(...qStripVals);
    }
    allQStdVals.push(...qStdVals);
  }

  // ── Step 5: Global thresholds ──
  // Exact: get_global_threshold(all_q_std_vals)
  const [globalStdThresh] = getGlobalThreshold(allQStdVals, 1);
  // Exact: get_global_threshold(all_q_vals, looseness=4)
  const [globalThr] = getGlobalThreshold(allQVals, 4);

  console.log(
    `Thresholding: globalThr=${roundTo(globalThr, 2)} globalStdTHR=${roundTo(globalStdThresh, 2)}${globalThr === 255 ? " (Looks like a Xeroxed OMR)" : ""}`
  );

  // ── Step 6: Per-strip detection ──
  // Exact port of core.py L266-391
  const omrResponse = {};
  let multiMarked = false;
  let totalQStripNo = 0;
  let totalQBoxNo = 0;

  // Convert finalMarked to color for visualization
  let finalMarkedColor = new cv.Mat();
  cv.cvtColor(finalMarked, finalMarkedColor, cv.COLOR_GRAY2RGBA);
  finalMarked.delete();

  for (const fieldBlock of template.fieldBlocks) {
    const [boxW, boxH] = fieldBlock.bubbleDimensions;

    for (const fieldBlockBubbles of fieldBlock.traverseBubbles) {
      // Exact: no_outliers = all_q_std_vals[total_q_strip_no] < global_std_thresh
      const noOutliers = allQStdVals[totalQStripNo] < globalStdThresh;

      // Exact: per_q_strip_threshold = get_local_threshold(...)
      const perQStripThreshold = getLocalThreshold(
        allQStripArrs[totalQStripNo],
        globalThr,
        noOutliers
      );

      let detectedBubbles = [];

      for (const bubble of fieldBlockBubbles) {
        // Exact: bubble_is_marked = per_q_strip_threshold > all_q_vals[total_q_box_no]
        const bubbleIsMarked = perQStripThreshold > allQVals[totalQBoxNo];
        totalQBoxNo++;

        const x = Math.round(bubble.x + fieldBlock.shift);
        const y = Math.round(bubble.y);

        if (bubbleIsMarked) {
          detectedBubbles.push(bubble);

          // Draw marked bubble: light gray background + dark value text
          cv.rectangle(
            finalMarkedColor,
            new cv.Point(x, y),
            new cv.Point(x + boxW, y + boxH),
            new cv.Scalar(200, 200, 200, 255),
            -1 // filled
          );
          // Draw value text centered
          const text = String(bubble.fieldValue);
          const textW = text.length * 8; // approx width for scale 0.5
          const textH = 10; // approx height for scale 0.5
          const textX = x + Math.floor((boxW - textW) / 2);
          const textY = y + Math.floor((boxH + textH) / 2);
          cv.putText(
            finalMarkedColor,
            text,
            new cv.Point(textX, textY),
            cv.FONT_HERSHEY_SIMPLEX,
            0.5,
            new cv.Scalar(0, 0, 0, 255),
            1
          );
        } else {
          // Draw empty bubble outline
          cv.rectangle(
            finalMarkedColor,
            new cv.Point(x, y),
            new cv.Point(x + boxW, y + boxH),
            new cv.Scalar(130, 130, 130, 255),
            1
          );
        }
      }

      // Exact: if len(detected_bubbles) > 2: detected_bubbles = []
      if (detectedBubbles.length > 2) {
        detectedBubbles = [];
      }

      // Build response
      for (const bubble of detectedBubbles) {
        const multiMarkedLocal =
          omrResponse.hasOwnProperty(bubble.fieldLabel);
        if (multiMarkedLocal) {
          omrResponse[bubble.fieldLabel] += bubble.fieldValue;
        } else {
          omrResponse[bubble.fieldLabel] = bubble.fieldValue;
        }
        multiMarked = multiMarked || multiMarkedLocal;
      }

      // Exact: if len(detected_bubbles) == 0: empty_val
      if (detectedBubbles.length === 0) {
        const fieldLabel = fieldBlockBubbles[0].fieldLabel;
        omrResponse[fieldLabel] = fieldBlock.emptyVal;
      }

      totalQStripNo++;
    }
  }

  // Apply translucent overlay (exact: alpha=0.65 blend)
  const alpha = 0.65;
  let blended = new cv.Mat();
  // Convert transpLayer to RGBA for blending
  let transpLayerColor = new cv.Mat();
  cv.cvtColor(transpLayer, transpLayerColor, cv.COLOR_GRAY2RGBA);
  cv.addWeighted(finalMarkedColor, alpha, transpLayerColor, 1 - alpha, 0, blended);
  transpLayer.delete();
  transpLayerColor.delete();
  finalMarkedColor.delete();

  img.delete();

  return {
    omrResponse,
    finalMarked: blended,
    multiMarked,
  };
}

// ─── AR Overlay Projection ──────────────────────────────────────────────────

/**
 * Projects template bubble rectangles onto the live camera feed
 * using the perspective transform matrix.
 *
 * Port of live_scanner.py L96-112
 *
 * @param {cv.Mat} displayMat - Live RGBA frame to draw on
 * @param {object} template - Template with fieldBlocks
 * @param {cv.Mat} liveMatrix - 3x3 perspective transform (template→camera)
 */
export function projectBubblesOnFrame(displayMat, template, liveMatrix) {
  for (const block of template.fieldBlocks) {
    const [boxW, boxH] = block.bubbleDimensions;

    // Batch all bubble corners for this block into one transform
    const allCorners = [];
    let bubbleCount = 0;

    for (const bubbles of block.traverseBubbles) {
      for (const b of bubbles) {
        // 4 corners per bubble: TL, TR, BR, BL
        allCorners.push(
          b.x, b.y,
          b.x + boxW, b.y,
          b.x + boxW, b.y + boxH,
          b.x, b.y + boxH
        );
        bubbleCount++;
      }
    }

    if (bubbleCount === 0) continue;

    // Single perspectiveTransform for all corners in this block
    const rectPts = cv.matFromArray(bubbleCount * 4, 1, cv.CV_32FC2, allCorners);
    const warpedAll = new cv.Mat();
    cv.perspectiveTransform(rectPts, warpedAll, liveMatrix);
    const warpData = warpedAll.data32F;

    // Draw each bubble as a polyline
    for (let i = 0; i < bubbleCount; i++) {
      const base = i * 4 * 2; // 4 points × 2 coords per bubble
      const ptsMat = cv.matFromArray(4, 1, cv.CV_32SC2, [
        Math.round(warpData[base]),     Math.round(warpData[base + 1]),
        Math.round(warpData[base + 2]), Math.round(warpData[base + 3]),
        Math.round(warpData[base + 4]), Math.round(warpData[base + 5]),
        Math.round(warpData[base + 6]), Math.round(warpData[base + 7]),
      ]);
      const ptsVec = new cv.MatVector();
      ptsVec.push_back(ptsMat);
      cv.polylines(
        displayMat,
        ptsVec,
        true,
        new cv.Scalar(0, 255, 150, 255),
        1
      );
      ptsMat.delete();
      ptsVec.delete();
    }

    rectPts.delete();
    warpedAll.delete();
  }
}

/**
 * Draw anchor bounding box on live feed.
 *
 * @param {cv.Mat} displayMat - RGBA frame
 * @param {Array<[number,number]>} anchors - 4 ordered anchor points
 */
export function drawAnchorBox(displayMat, anchors) {
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, [
    Math.round(anchors[0][0]), Math.round(anchors[0][1]),
    Math.round(anchors[1][0]), Math.round(anchors[1][1]),
    Math.round(anchors[2][0]), Math.round(anchors[2][1]),
    Math.round(anchors[3][0]), Math.round(anchors[3][1]),
  ]);
  const ptsVec = new cv.MatVector();
  ptsVec.push_back(pts);
  cv.polylines(displayMat, ptsVec, true, new cv.Scalar(0, 255, 0, 255), 2);
  pts.delete();
  ptsVec.delete();
}

// ─── Perspective Transform Helpers ──────────────────────────────────────────

/**
 * Create the template anchor points array for perspective transforms.
 * These define the corners of the "ideal flat" template space.
 *
 * @param {object} template - Template with pageDimensions
 * @returns {cv.Mat} 4×1 CV_32FC2 matrix of template corner points
 */
export function getTemplateAnchorsMat(template) {
  const [tw, th] = template.pageDimensions;
  return cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,      // Top-Left
    tw, 0,     // Top-Right
    tw, th,    // Bottom-Right
    0, th,     // Bottom-Left
  ]);
}

/**
 * Create a cv.Mat from anchor points array.
 *
 * @param {Array<[number,number]>} anchors - 4 anchor points
 * @returns {cv.Mat} 4×1 CV_32FC2 matrix
 */
export function anchorPointsToMat(anchors) {
  return cv.matFromArray(4, 1, cv.CV_32FC2, [
    anchors[0][0], anchors[0][1],
    anchors[1][0], anchors[1][1],
    anchors[2][0], anchors[2][1],
    anchors[3][0], anchors[3][1],
  ]);
}

/**
 * Warp perspective: camera → flat template space.
 * Returns a grayscale flattened image with CLAHE applied.
 *
 * Port of live_scanner.py L128-134
 *
 * @param {cv.Mat} frameMat - RGBA camera frame
 * @param {Array<[number,number]>} anchorHistory - Smoothed anchor points
 * @param {object} template - Template with pageDimensions
 * @returns {cv.Mat} Grayscale flattened paper
 */
export function warpToFlat(frameMat, anchorHistory, template) {
  const [tw, th] = template.pageDimensions;

  const srcMat = anchorPointsToMat(anchorHistory);
  const dstMat = getTemplateAnchorsMat(template);

  // Camera → Template perspective transform
  const matrix = cv.getPerspectiveTransform(srcMat, dstMat);

  // Warp perspective
  const flatPaper = new cv.Mat();
  cv.warpPerspective(
    frameMat,
    flatPaper,
    matrix,
    new cv.Size(tw, th)
  );

  // Convert to grayscale
  const grayFlat = new cv.Mat();
  cv.cvtColor(flatPaper, grayFlat, cv.COLOR_RGBA2GRAY);

  // Apply CLAHE for better contrast (clipLimit=2.0, tileGrid=8×8)
  applyCLAHE(grayFlat, grayFlat, 2.0, 8);

  // Cleanup
  srcMat.delete();
  dstMat.delete();
  matrix.delete();
  flatPaper.delete();

  return grayFlat;
}
