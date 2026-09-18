// SVG icon sprite: path data pulled from Google's Material Symbols (Outlined, 24px)
// https://github.com/google/material-design-icons/tree/master/symbols/web
// Only the individual icons this app uses are embedded here - not the full icon font. Each key
// is the icon's exact Material Symbols id (e.g. "open_with" - https://fonts.google.com/icons?icon.query=open_with),
// not a locally-invented name, so a path can be re-verified or swapped later by looking up that
// same id rather than guessing which upstream icon a key was meant to represent.
const ICON_PATHS: Record<string, string> = {
  hourglass_top:
    'M320-160h320v-120q0-66-47-113t-113-47q-66 0-113 47t-47 113v120ZM160-80v-80h80v-120q0-61 28.5-114.5T348-480q-51-32-79.5-85.5T240-680v-120h-80v-80h640v80h-80v120q0 61-28.5 114.5T612-480q51 32 79.5 85.5T720-280v120h80v80H160Z',
  volume_up:
    'M560-131v-82q90-26 145-100t55-168q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm440 40v-322q47 22 73.5 66t26.5 96q0 51-26.5 94.5T560-320ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z',
  volume_off:
    'M792-56 671-177q-25 16-53 27.5T560-131v-82q14-5 27.5-10t25.5-12L480-368v208L280-360H120v-240h128L56-792l56-56 736 736-56 56Zm-8-232-58-58q17-31 25.5-65t8.5-70q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 53-14.5 102T784-288ZM650-422l-90-90v-130q47 22 73.5 66t26.5 96q0 15-2.5 29.5T650-422ZM480-592 376-696l104-104v208Zm-80 238v-94l-72-72H200v80h114l86 86Zm-36-130Z',
  content_paste:
    'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h167q11-35 43-57.5t70-22.5q40 0 71.5 22.5T594-840h166q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560h-80v120H280v-120h-80v560Zm280-560q17 0 28.5-11.5T520-800q0-17-11.5-28.5T480-840q-17 0-28.5 11.5T440-800q0 17 11.5 28.5T480-760Z',
  keyboard:
    'M160-200q-33 0-56.5-23.5T80-280v-400q0-33 23.5-56.5T160-760h640q33 0 56.5 23.5T880-680v400q0 33-23.5 56.5T800-200H160Zm0-80h640v-400H160v400Zm160-40h320v-80H320v80ZM200-440h80v-80h-80v80Zm120 0h80v-80h-80v80Zm120 0h80v-80h-80v80Zm120 0h80v-80h-80v80Zm120 0h80v-80h-80v80ZM200-560h80v-80h-80v80Zm120 0h80v-80h-80v80Zm120 0h80v-80h-80v80Zm120 0h80v-80h-80v80Zm120 0h80v-80h-80v80ZM160-280v-400 400Z',
  fullscreen:
    'M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z',
  settings:
    'm370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z',
  power_settings_new:
    'M440-440v-400h80v400h-80Zm40 320q-74 0-139.5-28.5T226-226q-49-49-77.5-114.5T120-480q0-80 33-151t93-123l56 56q-48 40-75 97t-27 121q0 116 82 198t198 82q117 0 198.5-82T760-480q0-64-26.5-121T658-698l56-56q60 52 93 123t33 151q0 74-28.5 139.5t-77 114.5q-48.5 49-114 77.5T480-120Z',
  chevron_left: 'M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z',
  chevron_right: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z',
  close:
    'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
  arrow_back: 'm313-440 224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z',
  arrow_upward: 'M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z',
  arrow_forward: 'M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z',
  arrow_downward: 'M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z',
  open_with:
    'M480-80 317-243l44-44 89 89v-189h60v189l89-89 44 44L480-80ZM238-322 80-480l159-159 44 44-85 85h189v60H198l84 84-44 44Zm484 0-44-44 84-84H574v-60h188l-84-84 44-44 158 158-158 158ZM450-574v-188l-84 84-44-44 158-158 158 158-44 44-84-84v188h-60Z',
  delete:
    'M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z',
};

/** Injects the icon sprite (as hidden <symbol> defs) into the document once. Call before rendering any icon(). */
export function installIconSprite(): void {
  if (document.getElementById('icon-sprite')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'icon-sprite';
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.style.overflow = 'hidden';

  let defs = '';
  for (const [name, d] of Object.entries(ICON_PATHS)) {
    defs += `<symbol id="icon-${name}" viewBox="0 -960 960 960"><path d="${d}"/></symbol>`;
  }
  svg.innerHTML = defs;
  document.body.appendChild(svg);
}

/** Returns markup for an inline <svg><use> referencing a sprite icon by id. */
export function icon(name: keyof typeof ICON_PATHS, extraClass = ''): string {
  return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}
