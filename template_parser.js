/**
 * Template Parser — Exact port of:
 *   src/template.py  (Template, FieldBlock, Bubble)
 *   src/constants/common.py (FIELD_TYPES, thresholds)
 *   src/utils/parsing.py (parseFieldString, parseFields, getConcatenatedResponse)
 *   src/defaults/config.py (CONFIG_DEFAULTS)
 *   src/defaults/template.py (TEMPLATE_DEFAULTS)
 */

// ─── Constants from src/constants/common.py ─────────────────────────────────

export const FIELD_TYPES = {
  QTYPE_INT: {
    bubbleValues: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    direction: "vertical",
  },
  QTYPE_INT_FROM_1: {
    bubbleValues: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    direction: "vertical",
  },
  QTYPE_MCQ4: {
    bubbleValues: ["A", "B", "C", "D"],
    direction: "horizontal",
  },
  QTYPE_MCQ5: {
    bubbleValues: ["A", "B", "C", "D", "E"],
    direction: "horizontal",
  },
};

export const GLOBAL_PAGE_THRESHOLD_WHITE = 200;
export const GLOBAL_PAGE_THRESHOLD_BLACK = 100;

// ─── Config Defaults from src/defaults/config.py ────────────────────────────

export const CONFIG_DEFAULTS = {
  dimensions: {
    display_height: 1920,
    display_width: 1080,
    processing_height: 1920,
    processing_width: 1080,
  },
  threshold_params: {
    GAMMA_LOW: 0.75,
    MIN_GAP: 12,
    MIN_JUMP: 8,
    CONFIDENT_SURPLUS: 6,
    JUMP_DELTA: 25,
    PAGE_TYPE_FOR_THRESHOLD: "white",
  },
  alignment_params: {
    auto_align: true,
    match_col: 5,
    max_steps: 30,
    stride: 1,
    thickness: 3,
  },
  outputs: {
    show_image_level: 0,
    save_image_level: 0,
    save_detections: true,
    filter_out_multimarked_files: false,
  },
};

// ─── Template Defaults from src/defaults/template.py ────────────────────────

const TEMPLATE_DEFAULTS = {
  preProcessors: [],
  emptyValue: "",
  customLabels: {},
  outputColumns: [],
};

// ─── Field String Regex from src/schemas/constants.py ───────────────────────

const FIELD_STRING_REGEX_GROUPS = /^([^.\d]+)(\d+)\.{2,3}(\d+)$/;
const FIELD_LABEL_NUMBER_REGEX = /^([^\d]+)(\d*)$/;

// ─── Parsing Utils from src/utils/parsing.py ────────────────────────────────

/**
 * Parses a field string like "q1..10" into ["q1", "q2", ..., "q10"]
 * or returns ["fieldName"] for simple strings.
 * Exact port of parse_field_string() from parsing.py
 */
export function parseFieldString(fieldString) {
  if (fieldString.includes(".")) {
    const match = fieldString.match(FIELD_STRING_REGEX_GROUPS);
    if (!match) {
      throw new Error(`Invalid field string format: '${fieldString}'`);
    }
    const [, fieldPrefix, startStr, endStr] = match;
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (start >= end) {
      throw new Error(
        `Invalid range in field string: '${fieldString}', start: ${start} >= end: ${end}`
      );
    }
    const result = [];
    for (let i = start; i <= end; i++) {
      result.push(`${fieldPrefix}${i}`);
    }
    return result;
  }
  return [fieldString];
}

/**
 * Parses an array of field strings, expanding ranges.
 * Exact port of parse_fields() from parsing.py
 */
export function parseFields(key, fields) {
  const parsedFields = [];
  const fieldsSet = new Set();
  for (const fieldString of fields) {
    const fieldsArray = parseFieldString(fieldString);
    const currentSet = new Set(fieldsArray);
    for (const f of currentSet) {
      if (fieldsSet.has(f)) {
        throw new Error(
          `Given field string '${fieldString}' has overlapping field(s) with other fields in '${key}': ${fields}`
        );
      }
    }
    currentSet.forEach((f) => fieldsSet.add(f));
    parsedFields.push(...fieldsArray);
  }
  return parsedFields;
}

/**
 * Merges multi-column responses using custom labels.
 * Exact port of get_concatenated_response() from parsing.py
 */
export function getConcatenatedResponse(omrResponse, template) {
  const concatenatedResponse = {};

  // Custom labels: concatenate multiple field values
  for (const [fieldLabel, concatenateKeys] of Object.entries(
    template.customLabels
  )) {
    concatenatedResponse[fieldLabel] = concatenateKeys
      .map((k) => omrResponse[k] || "")
      .join("");
  }

  // Non-custom labels: pass through directly
  for (const fieldLabel of template.nonCustomLabels) {
    concatenatedResponse[fieldLabel] = omrResponse[fieldLabel];
  }

  return concatenatedResponse;
}

/**
 * Natural sort for output columns.
 * Exact port of custom_sort_output_columns() from parsing.py
 */
function customSortOutputColumns(fieldLabel) {
  const match = fieldLabel.match(FIELD_LABEL_NUMBER_REGEX);
  if (!match) return [fieldLabel, 0];
  return [match[1], match[2] ? parseInt(match[2], 10) : 0];
}

// ─── Bubble class from src/template.py ──────────────────────────────────────

export class Bubble {
  /**
   * Container for a Point Box on the OMR.
   * Exact port of Bubble class from template.py
   */
  constructor(pt, fieldLabel, fieldType, fieldValue) {
    this.x = Math.round(pt[0]);
    this.y = Math.round(pt[1]);
    this.fieldLabel = fieldLabel;
    this.fieldType = fieldType;
    this.fieldValue = fieldValue;
  }

  toString() {
    return `[${this.x}, ${this.y}]`;
  }
}

// ─── FieldBlock class from src/template.py ──────────────────────────────────

export class FieldBlock {
  /**
   * Exact port of FieldBlock class from template.py
   */
  constructor(blockName, fieldBlockObject) {
    this.name = blockName;
    this.shift = 0;
    this.setupFieldBlock(fieldBlockObject);
  }

  setupFieldBlock(fbo) {
    const bubbleDimensions = fbo.bubbleDimensions;
    const bubbleValues = fbo.bubbleValues;
    const bubblesGap = fbo.bubblesGap;
    const direction = fbo.direction;
    const fieldLabels = fbo.fieldLabels;
    const fieldType = fbo.fieldType;
    const labelsGap = fbo.labelsGap;
    const origin = fbo.origin;
    this.emptyVal = fbo.emptyValue;

    this.parsedFieldLabels = parseFields(
      `Field Block Labels: ${this.name}`,
      fieldLabels
    );
    this.origin = origin;
    this.bubbleDimensions = bubbleDimensions;

    this.calculateBlockDimensions(
      bubbleDimensions,
      bubbleValues,
      bubblesGap,
      direction,
      labelsGap
    );
    this.generateBubbleGrid(
      bubbleValues,
      bubblesGap,
      direction,
      fieldType,
      labelsGap
    );
  }

  /**
   * Exact port of calculate_block_dimensions() from template.py
   */
  calculateBlockDimensions(
    bubbleDimensions,
    bubbleValues,
    bubblesGap,
    direction,
    labelsGap
  ) {
    const [_h, _v] = direction === "vertical" ? [1, 0] : [0, 1];

    const valuesDimension = Math.floor(
      bubblesGap * (bubbleValues.length - 1) + bubbleDimensions[_h]
    );
    const fieldsDimension = Math.floor(
      labelsGap * (this.parsedFieldLabels.length - 1) + bubbleDimensions[_v]
    );

    this.dimensions =
      direction === "vertical"
        ? [fieldsDimension, valuesDimension]
        : [valuesDimension, fieldsDimension];
  }

  /**
   * Exact port of generate_bubble_grid() from template.py
   * Generates the 2D grid of Bubble objects.
   */
  generateBubbleGrid(bubbleValues, bubblesGap, direction, fieldType, labelsGap) {
    const [_h, _v] = direction === "vertical" ? [1, 0] : [0, 1];
    this.traverseBubbles = [];

    const leadPoint = [parseFloat(this.origin[0]), parseFloat(this.origin[1])];

    for (const fieldLabel of this.parsedFieldLabels) {
      const bubblePoint = [...leadPoint];
      const fieldBubbles = [];

      for (const bubbleValue of bubbleValues) {
        fieldBubbles.push(
          new Bubble([...bubblePoint], fieldLabel, fieldType, bubbleValue)
        );
        bubblePoint[_h] += bubblesGap;
      }

      this.traverseBubbles.push(fieldBubbles);
      leadPoint[_v] += labelsGap;
    }
  }
}

// ─── Template class from src/template.py ────────────────────────────────────

export class Template {
  /**
   * Exact port of Template class from template.py
   * Loads a template JSON and builds field blocks with bubble grids.
   */
  constructor(jsonObject) {
    // Merge with defaults
    const merged = { ...TEMPLATE_DEFAULTS, ...jsonObject };

    this.pageDimensions = merged.pageDimensions;
    this.bubbleDimensions = merged.bubbleDimensions;
    this.globalEmptyVal = merged.emptyValue;
    this.customLabelsObject = merged.customLabels || {};
    this.options = merged.options || {};

    // Parse output columns
    const outputColumnsArray = merged.outputColumns || [];
    this.outputColumns = outputColumnsArray.length > 0
      ? parseFields("Output Columns", outputColumnsArray)
      : [];

    // Setup field blocks
    this.fieldBlocks = [];
    this.allParsedLabels = new Set();
    const fieldBlocksObject = merged.fieldBlocks || {};
    for (const [blockName, fbo] of Object.entries(fieldBlocksObject)) {
      this.parseAndAddFieldBlock(blockName, fbo);
    }

    // Parse custom labels
    this.customLabels = {};
    const allParsedCustomLabels = new Set();
    for (const [customLabel, labelStrings] of Object.entries(
      this.customLabelsObject
    )) {
      const parsedLabels = parseFields(`Custom Label: ${customLabel}`, labelStrings);
      this.customLabels[customLabel] = parsedLabels;

      const parsedLabelsSet = new Set(parsedLabels);
      const missingCustomLabels = [...parsedLabelsSet].filter(
        (l) => !this.allParsedLabels.has(l)
      );
      if (missingCustomLabels.length > 0) {
        console.warn(
          `For '${customLabel}', missing labels: ${missingCustomLabels}`
        );
      }
      parsedLabels.forEach((l) => allParsedCustomLabels.add(l));
    }

    // Non-custom labels = all parsed labels minus custom label components
    this.nonCustomLabels = new Set(
      [...this.allParsedLabels].filter((l) => !allParsedCustomLabels.has(l))
    );

    // Fill output columns if empty
    if (this.outputColumns.length === 0) {
      const nonCustomColumns = [...this.nonCustomLabels];
      const allCustomColumns = Object.keys(this.customLabelsObject);
      const allTemplateColumns = [...nonCustomColumns, ...allCustomColumns];
      this.outputColumns = allTemplateColumns.sort((a, b) => {
        const sa = customSortOutputColumns(a);
        const sb = customSortOutputColumns(b);
        if (sa[0] < sb[0]) return -1;
        if (sa[0] > sb[0]) return 1;
        return sa[1] - sb[1];
      });
    }
  }

  /**
   * Exact port of parse_and_add_field_block() from template.py
   */
  parseAndAddFieldBlock(blockName, fieldBlockObject) {
    const preFilled = this.preFillFieldBlock(fieldBlockObject);
    const blockInstance = new FieldBlock(blockName, preFilled);
    this.fieldBlocks.push(blockInstance);

    // Track parsed labels
    for (const label of blockInstance.parsedFieldLabels) {
      this.allParsedLabels.add(label);
    }
  }

  /**
   * Exact port of pre_fill_field_block() from template.py
   * Resolves fieldType references and applies defaults.
   */
  preFillFieldBlock(fieldBlockObject) {
    let result;
    if (fieldBlockObject.fieldType && FIELD_TYPES[fieldBlockObject.fieldType]) {
      result = {
        ...fieldBlockObject,
        ...FIELD_TYPES[fieldBlockObject.fieldType],
      };
    } else {
      result = { ...fieldBlockObject, fieldType: "__CUSTOM__" };
    }

    return {
      direction: "vertical",
      emptyValue: this.globalEmptyVal,
      bubbleDimensions: this.bubbleDimensions,
      ...result,
    };
  }
}

/**
 * Load a template from a JSON URL.
 */
export async function loadTemplate(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load template: ${url} (${response.status})`);
  }
  const jsonObject = await response.json();
  return new Template(jsonObject);
}
