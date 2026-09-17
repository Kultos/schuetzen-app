'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadPlacementGrouping() {
  const source = fs.readFileSync(path.join(__dirname, '../public/manage.js'), 'utf8');
  const body = source.split('function placementGroupsForDiscipline')[1].split('async function showEvent')[0];
  const context = vm.createContext({});
  vm.runInContext(`function placementGroupsForDiscipline${body}`, context);
  return (archive, discipline) => vm.runInContext(
    `placementGroupsForDiscipline(${JSON.stringify(archive)},${JSON.stringify(discipline)})`, context
  );
}

test('Historische getrennte Wertungen werden mit eigenen Gruppen dargestellt', () => {
  const group = loadPlacementGrouping();
  const archive = {
    shooters: [{id:1,gender:'w'}, {id:2,gender:'m'}],
    placements: [
      {discipline_id:7,shooter_id:2,rank:1,best_points:90},
      {discipline_id:7,shooter_id:1,rank:1,best_points:95},
    ],
  };
  const groups = group(archive, {id:7,ranking_mode:'separate'});
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(([label, rows]) => [label, rows.map(row => row.shooter_id)]))), [
    ['Frauen',[1]], ['Männer',[2]],
  ]);
});

test('Historische gemeinsame Wertung bleibt eine einzelne Gruppe', () => {
  const group = loadPlacementGrouping();
  const archive = {shooters:[],placements:[{discipline_id:7,shooter_id:1,rank:1}]};
  const groups = group(archive, {id:7,ranking_mode:'combined'});
  assert.equal(groups.length,1);
  assert.equal(groups[0][0],'Einzelwertung');
});
