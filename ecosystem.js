import { ecosystemUrl, parseEcosystem, activityLabel} from './ecosystem-contract.mjs?v=20261014-evidence';
const root = document.querySelector             ('[data-ecosystem]');
if (root) {
  const form = root.querySelector                 ('[data-filters]') ;
  const field = (name        ) => form.elements.namedItem(name)                                        ;
  const results = root.querySelector             ('[data-ecosystem-results]') ;
  const count = root.querySelector             ('[data-result-count]') ;
  const error = root.querySelector             ('[data-ecosystem-error]') ;
  const retry = root.querySelector                   ('[data-retry]') ;
  let data                       ;
  let host                = null;
  const status                        = {verified:'已核身份',partial:'部分核实',historical:'历史记录',planned:'拟建',source_unavailable:'来源暂不可核'};
  const make = (tag        , text        ) => { const el=document.createElement(tag); el.textContent=text; return el; };
  const source = (label        , url        ) => { const a=document.createElement('a'); a.textContent=label; a.href=url; a.target='_blank'; a.rel='noopener noreferrer'; return a; };
  const navigate = (label        , kind        , id        ) => {
    const button=document.createElement('button');button.type='button';button.textContent=label;
    button.addEventListener('click',()=> { form.reset(); field('kind').value=kind; host=id; render(); form.scrollIntoView({block:'start'}); });
    return button;
  };
  function render() {
    if (!data) return;
    const isCentre=field('kind').value==='centres';
    field('topic').disabled=!isCentre;
    const q=field('q').value.trim().toLocaleLowerCase();
    const country=field('country').value, topic=field('topic').value;
    const fragment=document.createDocumentFragment();
    let shown=0;
    if (isCentre) for (const row of data.centres) {
      if ((host && row.host_organization_id!==host) || (country && row.country!==country) || (topic && !row.topics.includes(topic)) || ![row.name,row.host_label,...row.topics].join(' ').toLocaleLowerCase().includes(q)) continue;
      shown++;
      const card=make('article','');card.dataset.centreId=row.id;
      card.append(make('p',`${row.country} · ${status[row.identity_status]}`),make('h2',row.name));
      card.append(make('p',row.host_label));
      card.append(make('p',activityLabel(row)));
      if (row.activity_source_url) card.append(source(`活动材料${row.activity_as_of ? ` · ${row.activity_as_of}` : ''} ↗`,row.activity_source_url));
      if (row.research_character==='game_related_interdisciplinary') card.append(make('p','游戏相关交叉研究'));
      if (row.topics.length) card.append(make('p',row.topics.map(t=>t.replaceAll('_',' ')).join(' / ')));
      card.append(source('官方来源 ↗',row.source_url),make('p',`身份核查：${row.verified_at.slice(0,10)}；不代表近期活动已核；招生与学位承接需另核。`));
      if (row.host_organization_id) card.append(navigate('查看关联机构与学位项目','organizations',row.host_organization_id));
      else card.append(make('p','尚未关联公开学位目录；不表示没有学位路径。'));
      fragment.append(card);
    }
    else for (const row of data.organizations) {
      const memberIds=new Set(data.organizations.filter(o=>o.id===row.id || o.root_id===row.id).map(o=>o.id));
      const programs=data.programs.filter(p=>p.organization_ids.some(id=>memberIds.has(id)));
      if ((host && row.id!==host) || (country && row.country!==country) || ![row.name,...programs.map(p=>p.name)].join(' ').toLocaleLowerCase().includes(q)) continue;
      shown++;
      const card=make('article','');card.dataset.organizationId=row.id;
      card.append(make('p',row.country || '地区待核'),make('h2',row.name));
      const centres=data.centres.filter(c=>c.host_organization_id===row.id);
      if (centres.length) card.append(navigate(`查看 ${centres.length} 个关联中心`,'centres',row.id));
      if (programs.length) {
        const details=document.createElement('details'); details.append(make('summary',`${programs.length} 个已收录学位项目`));
        const list=make('ul','');
        for (const program of programs) {
          const li=make('li',''); li.append(source(`${program.degree_level === 'phd' ? '博士' : program.degree_level === 'master' ? '硕士' : program.degree_level} · ${program.name}`,program.official_url));list.append(li);
        }
        details.append(list);card.append(details);
      } else card.append(make('p','本机构记录未直接关联学位项目，不代表没有学位。'));
      fragment.append(card);
    }
    results.replaceChildren(fragment);
    count.textContent=`显示 ${shown} / ${isCentre ? data.centres.length : data.organizations.length} ${isCentre ? '个中心' : '个机构'}${host ? ' · 已限定关联机构，可清除筛选' : ''}`;
    if (!shown) results.append(make('p','当前筛选没有匹配记录；可清除筛选查看完整收录范围。'));
  }
  async function load() {
    retry.hidden=true;error.hidden=true;count.textContent='正在读取公共目录…';
    try {
      const response=await fetch(ecosystemUrl,{cache:'no-cache',referrerPolicy:'no-referrer',credentials:'omit',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data=parseEcosystem(await response.json());
      const countries=[...new Set([...data.centres,...data.organizations].map(r=>r.country).filter(Boolean))].sort();
      const topics=[...new Set(data.centres.flatMap(c=>c.topics))].sort();
      for (const [name,values,label] of [['country',countries,'全部地区'],['topic',topics,'全部方向']]         ) {
        const select=field(name)                     ;
        select.replaceChildren(new Option(label,''),...values.map(v=>new Option(v.replaceAll('_',' '),v)));
      }
      root .querySelector('[data-snapshot]') .textContent=`已收录 ${data.centres.length} 个中心、${data.organizations.length} 个机构、${data.programs.length} 个学位项目。中心发布 ${data.generated_at.slice(0,10)}；学位目录 ${data.catalog_generated_at.slice(0,10)}。这不是全球总量。`;
      render();
    } catch (reason) {
      data=undefined;results.replaceChildren();count.textContent='目录暂不可用，收录数量未知。';
      root .querySelector('[data-snapshot]') .textContent='公共目录暂不可用，数据版本未知。';
      error.textContent=`公开目录读取失败（${reason instanceof Error ? reason.message : '未知错误'}），请重试或使用下方数据入口。`;
      error.hidden=false;retry.hidden=false;
    }
  }
  form.addEventListener('submit',e=>e.preventDefault());
  form.addEventListener('input',()=>{host=null;render();});
  // The reset default action runs after this event; render in the next task.
  form.addEventListener('reset',()=>{host=null;setTimeout(render,0);});
  retry.addEventListener('click',load);
  void load();
}
