/**
 * Sidebar behavior — accordion groups + single active item.
 *
 * Markup contract:
 *   <div class="nav-group" data-group="finanzas">
 *     <button class="nav-row" data-toggle>...<svg class="chev">...</svg></button>
 *     <div class="sub-wrap">
 *       <button class="sub-row" data-leaf="corapsa">Recibos externos</button>
 *       <button class="sub-row" data-leaf="gastos">Gastos</button>
 *     </div>
 *   </div>
 *
 *   <button class="nav-row" data-leaf="pesaje">...</button>  (plain, non-grouped item)
 *
 * setActiveLeaf() only syncs visual nav state (active row + open group).
 * Leaf clicks call switchTab() (ui.js) instead, which shows the matching
 * view, fetches its data, and calls setActiveLeaf() itself once done.
 */
function initSidebar() {
  document.querySelectorAll('[data-toggle]').forEach((header) => {
    header.addEventListener('click', () => {
      const group = header.closest('.nav-group');
      const wasOpen = group.classList.contains('is-open');

      document.querySelectorAll('.nav-group').forEach((g) => g.classList.remove('is-open'));

      if (!wasOpen) {
        group.classList.add('is-open');
      }
    });
  });

  document.querySelectorAll('[data-leaf]').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      switchTab(row.dataset.leaf);
    });
  });
}

function setActiveLeaf(leafKey) {
  document.querySelectorAll('.nav-row.is-active, .sub-row.is-active').forEach((el) => {
    el.classList.remove('is-active');
  });

  const target = document.querySelector(`[data-leaf="${leafKey}"]`);
  if (!target) return;

  target.classList.add('is-active');

  const parentGroup = target.closest('.nav-group');
  document.querySelectorAll('.nav-group').forEach((g) => g.classList.toggle('is-open', g === parentGroup));
}

initSidebar();
