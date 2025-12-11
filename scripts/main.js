// scripts/main.js
const MODULE_ID = "the-horses-actor-visibility-tools";
const SOCKET = `module.${MODULE_ID}`;

/* -------------------- helpers -------------------- */

function feetToSceneUnits(ft) {
  const units = (canvas?.scene?.grid?.units || "").toLowerCase();
  if (!units) return ft;
  if (units.includes("ft")) return ft;
  if (units.includes("meter") || units === "m") return ft * 0.3048;
  if (units.includes("km")) return ft * 0.0003048;
  if (units.includes("mi")) return ft / 5280;
  return ft;
}

function centerOf(doc) {
  const d = canvas.dimensions;
  const x = (doc.x ?? 0) + ((doc.width ?? 1) * d.size) / 2;
  const y = (doc.y ?? 0) + ((doc.height ?? 1) * d.size) / 2;
  return { x, y };
}

function distanceBetweenDocs(aDoc, bDoc) {
  const d = canvas.dimensions;
  const ac = centerOf(aDoc);
  const bc = centerOf(bDoc);
  const px = Math.hypot(ac.x - bc.x, ac.y - bc.y);
  return (px / d.size) * d.distance;
}

function getPlayerAnchorDocs() {
  return canvas.scene?.tokens?.contents.filter(td => {
    const actor = game.actors?.get(td.actorId);
    return actor?.hasPlayerOwner;
  }) ?? [];
}

/* -------------------- GM helpers -------------------- */

/**
 * Returns the user object representing the primary GM. This is the first active GM if any
 * are connected, otherwise the first GM defined in the users list. If no GM exists,
 * returns null. By selecting a single GM client to perform certain actions (like
 * automatic Stealth rolls on token creation), we prevent duplicate rolls when multiple
 * players or GMs are present in the world.
 *
 * @returns {User|null} The primary GM user or null if none exist
 */
function getPrimaryGMUser() {
  const activeGMs = game.users?.filter(u => u.isGM && u.active) ?? [];
  if (activeGMs.length > 0) return activeGMs[0];
  // Fall back to any GM if no one is marked as active
  const anyGM = game.users?.find(u => u.isGM);
  return anyGM ?? null;
}

/**
 * Determine whether the current client corresponds to the primary GM. Only the
 * designated primary GM should perform certain side effects (such as automatic
 * Stealth checks) to avoid duplication across clients. Returns true only when
 * there is a GM and the current user's id matches that GM.
 *
 * @returns {boolean}
 */
function isPrimaryGM() {
  const primary = getPrimaryGMUser();
  return !!primary && game.user?.id === primary.id;
}

/* -------------------- core logic -------------------- */

function desiredHiddenState(tokenDoc) {
  // Always reveal player-owned tokens. They should never be auto-hidden.
  const actor = game.actors?.get(tokenDoc.actorId);
  if (actor?.hasPlayerOwner) return false;

  // Retrieve the minimum visibility distance set on the token. If the flag is
  // undefined, null, an empty string, NaN or non-positive, treat it as no
  // minimum and leave the token's current hidden state unchanged.
  const raw = tokenDoc.getFlag(MODULE_ID, "distance");
  const feet = Number(raw);
  if (raw === undefined || raw === null || raw === "" || Number.isNaN(feet) || feet <= 0) {
    return tokenDoc.hidden;
  }

  // If there are no player-owned tokens on the scene, remain hidden until one appears.
  const anchors = getPlayerAnchorDocs();
  if (!anchors.length) return true;

  // Convert the threshold to scene units and compare against the nearest anchor.
  const cutoffSceneUnits = feetToSceneUnits(feet);
  const nearest = Math.min(...anchors.map(a => distanceBetweenDocs(a, tokenDoc)));
  const within = nearest <= cutoffSceneUnits;
  return !within;
}

/** GM-only: scan and update hidden flags */
async function applyAllGM(sceneId) {
  if (!game.user.isGM) return;                // safety
  if (!canvas?.ready || !canvas.scene) return;
  if (sceneId && sceneId !== canvas.scene.id) return;

  const updates = [];
  for (const td of canvas.scene.tokens) {
    const shouldHide = desiredHiddenState(td);
    if (td.hidden !== shouldHide) updates.push({ _id: td.id, hidden: shouldHide });
  }
  if (updates.length) await canvas.scene.updateEmbeddedDocuments("Token", updates);
}

/* -------- route calls to GM so players don't need permissions -------- */

function routeApplyAll() {
  // debounce bursts of events
  clearTimeout(routeApplyAll._t);
  routeApplyAll._t = setTimeout(() => {
    const sceneId = canvas?.scene?.id;
    // If I'm the GM, do it locally
    if (game.user.isGM) return void applyAllGM(sceneId);

    // If no active GM, we can't update visibility — just bail quietly
    const gmOnline = game.users?.some(u => u.isGM && u.active);
    if (!gmOnline) return;

    // Ask any GM client to run applyAllGM
    game.socket?.emit(SOCKET, { op: "applyAll", sceneId });
  }, 0);
}

/* -------------------- stealth-on-creation -------------------- */

function scheduleStealthRollForTokenDoc(tokenDoc) {
  // Determine whether the newly created token should roll stealth. We first
  // consult the flag on the token itself. If absent, fall back to the flag on
  // the actor's prototype token. This fallback allows dragging an actor whose
  // prototype has stealth-on-creation enabled to still produce a stealth roll
  // even if the TokenDocument does not yet have the flag explicitly set.
  let stealthOnCreate = tokenDoc.getFlag(MODULE_ID, "stealthOnCreate");
  if (stealthOnCreate === undefined || stealthOnCreate === null) {
    const actor = game.actors?.get(tokenDoc.actorId);
    stealthOnCreate = actor?.prototypeToken?.getFlag(MODULE_ID, "stealthOnCreate");
  }
  if (!stealthOnCreate) return;
  // Only GMs should roll for stealth. Previously this check limited rolling to
  // the "primary GM" which could cause the roll to never occur if the user
  // dragging the actor was not the first GM. Now any active GM client that
  // creates the token will perform the roll, which avoids duplicates in most
  // cases while ensuring the roll still occurs.
  if (!game.user?.isGM) return;

  const actor = game.actors?.get(tokenDoc.actorId);
  if (!actor) return;

  // Helper to perform the actual roll. We attempt to use the dnd5e-specific
  // rollSkill method when available. If that is not present or fails, we
  // fall back to rolling 1d20 and sending a generic Stealth message.
  const performRoll = async () => {
    try {
      // Determine an appropriate chat speaker. We attempt to use the placed
      // token (if it exists on the canvas) to tie the message to the token's
      // scene representation; otherwise default to the actor alone.
      const speaker = ChatMessage.getSpeaker({ actor, token: canvas.tokens?.get(tokenDoc.id), scene: canvas.scene });
      // If the dnd5e system provides a rollSkill method, use it
      if (game.system.id === "dnd5e" && typeof actor.rollSkill === "function") {
        await actor.rollSkill("ste", {
          fastForward: true,
          skipDialog: true,
          speaker
        });
        return;
      }
      // Fallback for dnd5e v5.2.x where skills may be stored under system.skills.ste
      if (actor.system?.skills?.ste?.roll && typeof actor.system.skills.ste.roll === "function") {
        await actor.system.skills.ste.roll({
          fastForward: true,
          skipDialog: true,
          speaker
        });
        return;
      }
      // Last fallback: roll a simple d20
      const roll = await (new Roll("1d20")).roll({ async: true });
      await roll.toMessage({
        flavor: "Stealth (fallback)",
        speaker
      });
    } catch (err) {
      console.error(`[${MODULE_ID}] Stealth on creation failed:`, err);
    }
  };

  // Perform the roll after a brief delay to allow the token to be drawn to the
  // canvas and registered in canvas.tokens. This avoids missing the drawToken
  // hook and allows the chat speaker to include the token reference when
  // possible. If the token is not yet available, we still proceed using the
  // actor alone.
  setTimeout(() => {
    performRoll();
  }, 100);
}

/* -------------------- token config UI -------------------- */

/**
 * Render a dedicated configuration section for the Minimum Visibility module in the
 * Appearance tab of Token and Prototype Token configuration sheets. This
 * function is inspired by the Swarm module's UI pattern, using a fieldset
 * and legend to group related inputs. It works in both Foundry v12 and v13 by
 * detecting whether the supplied html argument is a jQuery wrapper or a
 * native HTMLElement and gracefully handling partial re-renders in v13.
 *
 * The section contains two controls:
 *  - A number input for the minimum visibility distance in feet. When left
 *    blank or set to zero, no auto-hiding occurs.
 *  - A checkbox to automatically roll Stealth when the token is created.
 *
 * @param {object} app    The application instance (TokenConfig or PrototypeTokenConfig)
 * @param {HTMLElement|jQuery} html  The root element or jQuery wrapper of the rendered sheet
 * @param {any} data      The data context for the sheet (unused)
 * @param {object} options Options including partial render parts
 */
function renderMinVisibilityConfig(app, html, data, options) {
  const tabName = "appearance";
  // Skip if this is a partial re-render that does not include the appearance tab (v13)
  if (options && options.parts && !options.parts.includes(tabName)) return;

  // Determine the document context used to create new elements. In v12, app.element
  // exists and contains the ownerDocument; in v13, document can be used directly.
  const doc = (app.element && app.element.ownerDocument) || document;

  // The html argument may be a jQuery object (v12) or a plain HTMLElement (v13).
  let appearanceTab = null;
  if (html && typeof html[0] !== 'undefined' && html[0]?.querySelector) {
    appearanceTab = html[0].querySelector(`div[data-tab='${tabName}']`);
  }
  if (!appearanceTab && html && html.querySelector) {
    appearanceTab = html.querySelector(`div[data-tab='${tabName}']`);
  }
  if (!appearanceTab) return;

  // Avoid duplicate insertion on re-render. Mark inserted sections with the class
  // mvd-section so repeated renders do not produce multiple sections.
  if (appearanceTab.querySelector('.mvd-section')) return;

  // Determine the token document to read and write flags. For placed tokens
  // use app.token, for prototype tokens use app.document.
  const token = app.token || app.document;
  let flags = token.flags;
  if (flags === undefined) flags = token.data?.flags;
  const modFlags = flags?.[MODULE_ID] || {};
  const currentDistance = modFlags.distance ?? "";

  // Build a fieldset to contain our controls. Using a fieldset and legend
  // matches Foundry's built-in styling for sheet sections (e.g. Basic Configuration).
  const fieldset = doc.createElement('fieldset');
  fieldset.classList.add('mvd-section');

  const legend = doc.createElement('legend');
  legend.textContent = 'Minimum Visibility';
  fieldset.appendChild(legend);

  // --- Distance input group ---
  const distGroup = doc.createElement('div');
  distGroup.classList.add('form-group', 'slim');
  fieldset.appendChild(distGroup);

  const distLabel = doc.createElement('label');
  distLabel.textContent = 'Minimum Visibility Distance (ft)';
  distGroup.appendChild(distLabel);

  const distFields = doc.createElement('div');
  distFields.classList.add('form-fields');
  distGroup.appendChild(distFields);

  const distInput = doc.createElement('input');
  distInput.type = 'number';
  distInput.name = `flags.${MODULE_ID}.distance`;
  distInput.min = '0';
  distInput.step = '1';
  distInput.placeholder = '';
  if (currentDistance !== "" && currentDistance !== null && currentDistance !== undefined) {
    distInput.value = currentDistance;
  }
  distFields.appendChild(distInput);

  const distHint = doc.createElement('p');
  distHint.classList.add('hint');
  distHint.textContent = 'Minimum distance in feet. If blank or zero, the token will not be auto-hidden.';
  distGroup.appendChild(distHint);

  // --- Stealth on Creation group ---
  const stealthGroup = doc.createElement('div');
  stealthGroup.classList.add('form-group');
  fieldset.appendChild(stealthGroup);

  const stealthLabel = doc.createElement('label');
  stealthLabel.textContent = 'Stealth on Creation';
  stealthGroup.appendChild(stealthLabel);

  const stealthFields = doc.createElement('div');
  stealthFields.classList.add('form-fields');
  stealthGroup.appendChild(stealthFields);

  const stealthInput = doc.createElement('input');
  stealthInput.type = 'checkbox';
  stealthInput.name = `flags.${MODULE_ID}.stealthOnCreate`;
  stealthInput.setAttribute('data-dtype', 'Boolean');
  if (token.getFlag(MODULE_ID, 'stealthOnCreate')) {
    stealthInput.checked = true;
  }
  stealthFields.appendChild(stealthInput);

  const stealthHint = doc.createElement('p');
  stealthHint.classList.add('hint');
  stealthHint.textContent = 'When placed on the scene, this token immediately rolls Stealth as the token.';
  stealthGroup.appendChild(stealthHint);

  // Append the fieldset to the appearance tab. By appending at the end, our
  // section appears below existing configuration sections.
  appearanceTab.appendChild(fieldset);

  // Resize the window to accommodate the new controls.
  if (typeof app.setPosition === 'function') app.setPosition();
}

function injectTokenConfig(app, html) {
  const enabled         = app.object.getFlag(MODULE_ID, "enabled") ?? false;
  const distance        = app.object.getFlag(MODULE_ID, "distance") ?? 60;
  const stealthOnCreate = app.object.getFlag(MODULE_ID, "stealthOnCreate") ?? false;

  const $tab = html.find('.tab[data-tab="appearance"]');
  const frag = $(`
    <div class="form-group">
      <label>Proximity Reveal</label>
      <div class="form-fields">
        <input type="checkbox" name="flags.${MODULE_ID}.enabled" data-dtype="Boolean">
        <span class="notes">Hide this token until a player-owned token is nearby.</span>
      </div>
    </div>
    <div class="form-group">
      <label>Reveal Distance</label>
      <div class="form-fields">
        <input type="number" name="flags.${MODULE_ID}.distance" step="1" min="0" placeholder="60">
        <span class="units">ft</span>
      </div>
      <p class="notes">When any player-owned token is within this many feet, this token becomes visible to everyone.</p>
    </div>
    <hr>
    <div class="form-group">
      <label>Stealth on Creation</label>
      <div class="form-fields">
        <input type="checkbox" name="flags.${MODULE_ID}.stealthOnCreate" data-dtype="Boolean">
        <span class="notes">When placed on the scene, this token immediately rolls Stealth as the token.</span>
      </div>
    </div>
  `);

  $tab.append(frag);
  $tab.find(`input[name="flags.${MODULE_ID}.enabled"]`).prop("checked", !!enabled);
  $tab.find(`input[name="flags.${MODULE_ID}.distance"]`).val(distance);
  $tab.find(`input[name="flags.${MODULE_ID}.stealthOnCreate"]`).prop("checked", !!stealthOnCreate);
}

/*
 * In Foundry VTT v13 all core applications (including TokenConfig) extend
 * ApplicationV2 and receive plain HTMLElement objects in their render hook
 * callbacks instead of jQuery wrappers. Additionally these applications may
 * perform partial re-renders where only specific tabs are refreshed. To
 * support these changes we define a separate injection function which uses
 * vanilla DOM methods and the built-in field helpers to construct our
 * inputs. This function is only hooked for TokenConfig in v13 via
 * Hooks.on below.
 *
 * @param {TokenConfig} app
 * @param {HTMLElement|jQuery} html  The root element of the rendered sheet
 * @param {any} context               The render context (unused)
 * @param {object} options            Options including partial render parts
 */
function injectTokenConfigV13(app, html, context, options) {
  // Normalize the html argument to a DOM element. In v13 this is a plain
  // HTMLElement, while in earlier versions it may be a jQuery wrapper.
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // Support partial re-rendering: only insert controls when the appearance
  // tab is part of the update. The options parameter is only present in v13.
  if (options && options.parts && !options.parts.includes("appearance")) return;

  // Find the appearance tab. In AppV2 the tab element may be a div, section,
  // or other element; selecting by data-tab attribute alone is safer than
  // requiring a specific class.
  const tab = root.querySelector('[data-tab="appearance"]');
  if (!tab) return;

  // Avoid duplicate insertion on re-render.
  if (tab.querySelector('.mvd-wrapper')) return;

  // Determine the token document. app.document is preferred for v13; fall back to app.object.
  const doc = app.document ?? app.object;
  if (!doc) return;

  // Retrieve existing flag values. Distance is stored as a string or number
  // on the token. If undefined, null, empty string or NaN, the distance
  // field will be blank and no auto-hide will occur. We ignore any legacy
  // "enabled" flag; it will be left untouched but no longer controls
  // visibility.
  const rawDistance     = doc.getFlag(MODULE_ID, 'distance');
  const distance        = (rawDistance === undefined || rawDistance === null || rawDistance === '') ? '' : Number(rawDistance);
  const stealthOnCreate = doc.getFlag(MODULE_ID, 'stealthOnCreate') ?? false;

  // Use Foundry's field helpers to build consistent inputs. These helpers
  // automatically apply styling and data-binding attributes expected by the
  // document sheet. Without them, the form might not behave correctly in v13.
  const fields = foundry.applications.fields;
  const distanceInput = fields.createNumberInput({
    name: `flags.${MODULE_ID}.distance`,
    value: distance,
    step: 1,
    min: 0
  });
  const stealthInput = fields.createCheckboxInput({
    name: `flags.${MODULE_ID}.stealthOnCreate`,
    value: !!stealthOnCreate
  });

  // Create form groups with labels and hints. Only two groups are needed:
  // one for the minimum visibility distance and one for stealth-on-creation.
  const group1 = fields.createFormGroup({
    label: 'Minimum Visibility Distance',
    input: distanceInput,
    hint: 'Enter a distance in feet. If blank or zero, the token will not be auto-hidden.'
  });
  const group2 = fields.createFormGroup({
    label: 'Stealth on Creation',
    input: stealthInput,
    hint: 'When placed on the scene, this token immediately rolls Stealth as the token.'
  });

  // Bundle our groups and separator into a wrapper to mark insertion. The
  // wrapper class allows us to detect duplicates on future renders. A
  // section header is also created to visually group the inputs similar to
  // other sections on the sheet (e.g. "Basic Configuration").
  const header = document.createElement('h3');
  header.classList.add('form-header');
  header.textContent = 'Minimum Visibility';

  const wrapper = document.createElement('div');
  wrapper.classList.add('mvd-wrapper');
  wrapper.append(group1);
  const hr = document.createElement('hr');
  wrapper.append(hr);
  wrapper.append(group2);

  // Append the header and wrapper to the tab. The header provides a
  // recognizable section title and ensures our fields are visually separated
  // from other token configuration controls.
  tab.append(header);
  tab.append(wrapper);

  // After modifying the DOM, resize the window to fit the new fields.
  if (typeof app.setPosition === 'function') app.setPosition();
}

/* -------------------- hooks -------------------- */

Hooks.once("init", () => console.log(`[${MODULE_ID}] init`));

Hooks.once("ready", () => {
  // GM-side socket handler
  game.socket?.on(SOCKET, async (data) => {
    if (!data || !game.user.isGM) return;
    if (data.op === "applyAll") await applyAllGM(data.sceneId);
  });
});

// Use a wrapper to support both AppV1 (v12) and AppV2 (v13) render hooks.
// In AppV1 the html argument is a jQuery wrapper, which exposes the `.find`
// method. In AppV2 it is a plain HTMLElement. Choose the appropriate
// injection function based on the presence of `.find`.
// Register the Minimum Visibility section on both Token and Prototype Token configuration sheets.
Hooks.on("renderTokenConfig", (app, html, data, options) => {
  try {
    renderMinVisibilityConfig(app, html, data, options);
  } catch (err) {
    console.error(`[${MODULE_ID}] Failed to render Minimum Visibility config:`, err);
  }
});

Hooks.on("renderPrototypeTokenConfig", (app, html, data, options) => {
  try {
    renderMinVisibilityConfig(app, html, data, options);
  } catch (err) {
    console.error(`[${MODULE_ID}] Failed to render Minimum Visibility config:`, err);
  }
});

// Route all recomputes through the GM
Hooks.on("canvasReady", routeApplyAll);
Hooks.on("createToken", (doc) => {
  routeApplyAll();
  // stealth-on-creation (doesn't require GM rights)
  try { scheduleStealthRollForTokenDoc(doc); } catch (e) { console.error(`[${MODULE_ID}]`, e); }
});
Hooks.on("deleteToken", routeApplyAll);
Hooks.on("updateToken", (doc, changes) => {
  if ("x" in changes || "y" in changes || "hidden" in changes || (changes.flags && MODULE_ID in changes.flags)) {
    routeApplyAll();
  }
});
Hooks.on("updateActor", (doc, changes) => {
  if ("ownership" in changes) routeApplyAll();
});
Hooks.on("sightRefresh", routeApplyAll);
Hooks.on("updateScene", routeApplyAll);
