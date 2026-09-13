'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
  const nodes=new Map();
  function node(tag='div',attrs={},children=[]) {
    const value={tag,children,textContent:attrs.text || '',value:'',hidden:false,
      appendChild(child){this.children.push(child);return child;},append(...items){this.children.push(...items);},
      replaceChildren(...items){this.children=items;},addEventListener(){},focus(){}};
    Object.assign(value,attrs);return value;
  }
  const document={
    getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},
    querySelector(){return null;}
  };
  const state={event:{scoring_mode:'both',team_max_members:5,team_counted_results:3},teams:[
    {id:1,name:'Adler',member_count:2,members:[
      {shooter_id:11,start_number:1,name:'Anna'},
      {shooter_id:12,start_number:2,name:'Berta'}
    ]},
    {id:2,name:'Falken',member_count:1,members:[{shooter_id:13,start_number:3,name:'Carla'}]}
  ],shooters:[
    {id:11,start_number:1,name:'Anna'},{id:12,start_number:2,name:'Berta'},
    {id:13,start_number:3,name:'Carla'},{id:14,start_number:4,name:'Dora'}
  ],disciplines:[{id:21,name:'Luftgewehr'},{id:22,name:'Luftpistole'}]};
  const context=vm.createContext({document,state,el:node,api:async()=>[],formatPoints:String,prompt:()=>null,confirm:()=>true,
    resultView:{},activateTab(){},rankingView:{mode:'individual'}});
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  vm.runInContext(source.split('// ---------------- Teams ----------------')[1].split('// ---------------- Results ----------------')[0],context);
  return {nodes,state,run:code=>vm.runInContext(code,context)};
}

test('Mannschaftsansicht zeigt Disziplinsummen und Ergebnisse der Mitglieder',()=>{
  const ui=setup();
  ui.run(`teamView.teamId=1;teamView.rankings=new Map([
    [21,{rank:2,total_points:180,counted_count:2,required_count:3,entries:[
      {shooter_id:11,points:95,round_number:1,counted:true},
      {shooter_id:12,points:85,round_number:2,counted:true}
    ]}],
    [22,null]
  ]);renderTeamOverview()`);
  assert.equal(ui.nodes.get('teamDisciplineSummaries').children.length,2);
  assert.equal(ui.nodes.get('teamDisciplineSummaries').children[0].children[1].textContent,'180');
  assert.match(ui.nodes.get('teamDisciplineSummaries').children[0].children[2].textContent,/Platz 2/);
  const rows=ui.nodes.get('teamResultsBody').children;
  assert.equal(rows.length,2);
  assert.equal(rows[0].children[2].children[0].textContent,'95');
  assert.equal(rows[0].children[3].children[1].textContent,'nicht markiert');
});

test('Mitgliederverwaltung bleibt hinter Schützen hinzufügen verfügbar',()=>{
  const ui=setup();
  ui.run('teamView.teamId=1;teamView.addOpen=true;renderTeamMemberPanel()');
  const candidates=ui.nodes.get('availableTeamMembers').children;
  assert.equal(candidates.length,2);
  assert.equal(candidates[0].children[1].textContent,'Verschieben');
  assert.equal(candidates[1].children[1].textContent,'Hinzufügen');
});
