'use strict';

const disciplines = ['Luftgewehr', 'Luftpistole', 'Kleinkaliber', 'Luftgewehr Auflage'];
const demoShooters = [
  { id: 12, name: 'Alex Beispiel', results: [[89.5, 94.2, 91.8], [82.4, 87.1], [], [98.6]] },
  { id: 18, name: 'Kim Muster', results: [[92.1], [], [85.6, 88.2], []] },
  { id: 23, name: 'Robin Demo', results: [[], [], [], []] },
  { id: 31, name: 'Toni Test', results: [[95.3, 96.1], [90.2], [87.5], [99.1, 98.4]] },
  { id: 42, name: 'Sascha Beispiel', results: [[], [0], [], []] },
];
let shooters = structuredClone(demoShooters);
let selectedId = 12;
let feedbackTimer;
const $ = (id) => document.getElementById(id);
const points = (value) => value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function matches() {
  const query = $('search').value.trim().toLocaleLowerCase('de-DE');
  return shooters.filter((shooter) => `${shooter.id} ${shooter.name}`.toLocaleLowerCase('de-DE').includes(query));
}

function renderList() {
  $('shooterList').replaceChildren();
  const filtered = matches();
  for (const shooter of filtered) {
    const button = element('button', 'shooter-option');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(shooter.id === selectedId));
    const description = element('span', '', shooter.name);
    description.append(element('small', '', `${shooter.results.filter((rounds) => rounds.length).length} von ${disciplines.length} mit Ergebnissen`));
    button.append(element('span', 'small-number', `#${shooter.id}`), description);
    button.addEventListener('click', () => selectShooter(shooter.id));
    $('shooterList').append(button);
  }
  $('searchCount').textContent = filtered.length ? `${filtered.length} Schützen gefunden` : 'Keine Treffer. Name oder Startnummer prüfen.';
}

function selectShooter(id) {
  selectedId = id;
  $('feedback').textContent = '';
  renderList();
  renderOverview();
}

function renderOverview() {
  const shooter = shooters.find((item) => item.id === selectedId);
  $('startNumber').textContent = `#${shooter.id}`;
  $('shooterName').textContent = shooter.name;
  $('progress').replaceChildren(element('strong', '', `${shooter.results.filter((rounds) => rounds.length).length} / ${disciplines.length}`), document.createTextNode('Disziplinen mit Ergebnissen'));
  $('disciplines').replaceChildren();
  disciplines.forEach((name, index) => {
    const rounds = shooter.results[index];
    if ($('shotOnly').checked && !rounds.length) return;
    const card = element('article', `discipline${rounds.length ? '' : ' unplayed'}`);
    const row = element('div', 'discipline-main');
    const details = element('div');
    details.append(element('h4', '', name), element('span', 'status', rounds.length ? `✓ ${rounds.length} ${rounds.length === 1 ? 'Durchgang' : 'Durchgänge'} erfasst` : '○ Noch kein Ergebnis'));
    const best = rounds.length ? Math.max(...rounds) : null;
    if (rounds.length) {
      const chips = element('div', 'rounds');
      rounds.forEach((value, round) => {
        const chip = element('span', `round${value === best ? ' best' : ''}`);
        chip.append(element('small', '', `D${round + 1}`), document.createTextNode(points(value)));
        if (value === best) chip.title = 'Bester Durchgang';
        chips.append(chip);
      });
      details.append(chips);
    }
    const score = element('div', 'best-score', best === null ? '–' : points(best));
    score.append(element('small', '', 'Bestwert'));
    const add = element('button', '', rounds.length ? '+ Durchgang' : '+ Erfassen');
    add.id = `add-${index}`;
    add.setAttribute('aria-label', `${name}: Durchgang erfassen`);
    add.setAttribute('aria-expanded', 'false');
    add.addEventListener('click', () => {
      const existing = card.querySelector('form');
      if (existing) { existing.querySelector('input').focus(); return; }
      add.setAttribute('aria-expanded', 'true');
      const form = element('form', 'entry');
      const label = element('label', '', `${shooter.name} · ${name} · Durchgang ${rounds.length + 1}`);
      label.htmlFor = `points-${index}`;
      const input = element('input');
      input.id = label.htmlFor;
      input.type = 'number';
      input.step = '0.1';
      input.required = true;
      input.placeholder = 'Punkte';
      input.setAttribute('aria-label', `Punkte für ${name}`);
      const fields = element('div', 'entry-fields');
      const save = element('button', 'primary', 'Speichern');
      save.type = 'submit';
      const cancel = element('button', 'quiet', 'Abbrechen');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { form.remove(); add.setAttribute('aria-expanded', 'false'); add.focus(); });
      fields.append(input, save, cancel);
      form.append(label, fields);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input.valueAsNumber;
        if (!Number.isFinite(value)) return;
        rounds.push(value);
        renderList();
        renderOverview();
        $(`add-${index}`).focus();
        clearTimeout(feedbackTimer);
        $('feedback').textContent = `${points(value)} Punkte für ${shooter.name} · ${name} in der Demo gespeichert.`;
        feedbackTimer = setTimeout(() => { $('feedback').textContent = ''; }, 5000);
      });
      card.append(form);
      input.focus();
    });
    row.append(details, score, add);
    card.append(row);
    $('disciplines').append(card);
  });
  if (!$('disciplines').children.length) {
    $('disciplines').append(element('p', 'muted', 'Für diesen Schützen sind noch keine Ergebnisse erfasst. Deaktiviere den Filter, um einen Durchgang einzutragen.'));
  }
}

$('search').addEventListener('input', renderList);
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && matches().length) {
    event.preventDefault();
    selectShooter(matches()[0].id);
    $('shooterName').tabIndex = -1;
    $('shooterName').focus();
  }
});
$('shotOnly').addEventListener('change', renderOverview);
$('reset').addEventListener('click', () => {
  shooters = structuredClone(demoShooters);
  $('search').value = '';
  $('shotOnly').checked = false;
  selectShooter(12);
});
renderList();
renderOverview();
