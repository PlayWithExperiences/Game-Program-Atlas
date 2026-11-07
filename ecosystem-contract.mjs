export const ecosystemUrl = 'research-ecosystem.json';




const legacyCentreKeys = 'id organization_id host_organization_id name host_label country topics identity_status source_url verified_at'.split(' ');
const activityDefaults = {activity_status:'not_reviewed',activity_as_of:null,activity_source_url:null,research_character:'not_reviewed'};
const centreKeys = [...legacyCentreKeys,...Object.keys(activityDefaults)];
function activity(row) {
  if (!['not_reviewed','dated_evidence','current_status_unknown'].includes(row.activity_status) || !['not_reviewed','game_related_interdisciplinary'].includes(row.research_character)) throw new Error('活动或研究性质状态无效');
  const period=row.activity_as_of, url=row.activity_source_url;
  if ((period===null)!==(url===null) || (row.activity_status==='dated_evidence' && period===null) || (row.activity_status==='not_reviewed' && period!==null)) throw new Error('活动材料日期与来源必须对应');
  if (period!==null) {
    if (typeof period!=='string' || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(period)) throw new Error('活动日期精度无效');
    const [year,month=1,day=1]=period.split('-').map(Number);
    const d=new Date(`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T00:00:00Z`);
    if (year<1 || !Number.isFinite(d.getTime()) || d.getUTCFullYear()!==year || d.getUTCMonth()+1!==month || d.getUTCDate()!==day) throw new Error('活动日期无效');
    source(url);
  }
}
export function activityLabel(row) {
  if (row.activity_status==='dated_evidence') return `有${row.activity_as_of}活动材料，不等于当前活跃`;
  if (row.activity_status==='current_status_unknown') return '暂未查到活跃证据';
  return '活动时效未单独核对';
}
function record(value         , keys          )                          {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== keys.sort().join('|')) throw new Error('公开数据字段不符合约定');
  return value                           ;
}
function texts(row                         , keys          ) {
  for (const key of keys) if (typeof row[key] !== 'string' || !(row[key]          ).trim()) throw new Error('公开文本缺失');
}
function strings(value         )                            {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error('公开列表无效');
}
function privateHost(host) {
  const h=host.toLowerCase().replace(/\.$/,'');
  if (h==='localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('[')) return !/^\[2[0-9a-f]{3}:/.test(h); // Global IPv6 unicast only.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a,b]=h.split('.').map(Number);
    return a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127);
  }
  return false;
}
function source(value         ) {
  if (typeof value !== 'string') throw new Error('来源缺失');
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || privateHost(u.hostname)) throw new Error('来源不是公共网页');
}
export function parseEcosystem(value         )            {
  const data = record(value, ['schema_version','catalog_owner','generated_at','catalog_generated_at','centres','organizations','programs']);
  const legacy=data.schema_version==='research-ecosystem/v1';
  if (!['research-ecosystem/v1','research-ecosystem/v2'].includes(data.schema_version) || data.catalog_owner !== 'Game Program Atlas') throw new Error('公开目录版本不兼容');
  for (const key of ['generated_at','catalog_generated_at']) if (typeof data[key] !== 'string' || !Number.isFinite(Date.parse(data[key]          ))) throw new Error('快照日期无效');
  for (const key of ['centres','organizations','programs']) {
    if (!Array.isArray(data[key]) || !(data[key]             ).length) throw new Error('公开目录为空，不能当作没有记录');
    const ids = new Set();
    for (const row of data[key]                            ) {
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('实体标识缺失或重复');
      ids.add(row.id);
    }
  }
  const ids = new Set((data.organizations                            ).map(r=>r.id));
  for (const value of data.organizations             ) {
    const row = record(value,['id','name','type','country','root_id']);
    if (!ids.has(row.root_id)) throw new Error('机构归属缺失'); texts(row,['id','name','type']);
    if (typeof row.country !== 'string') throw new Error('地区无效');
  }
  const centres=[];
  for (const value of data.centres             ) {
    record(value,legacy?legacyCentreKeys:centreKeys);
    const row = {...activityDefaults,...value}; activity(row); centres.push(row); texts(row,['id','organization_id','name','host_label','country','identity_status','verified_at']); strings(row.topics); source(row.source_url);
    if (row.id !== `centre:${row.organization_id}` || !['verified','partial','historical','planned','source_unavailable'].includes(row.identity_status          ) || !Number.isFinite(Date.parse(row.verified_at          ))) throw new Error('中心身份或核查日期无效');
    if (row.host_organization_id !== null && !ids.has(row.host_organization_id)) throw new Error('中心关联机构缺失');
  }
  for (const value of data.programs             ) {
    const row = record(value,['id','name','degree_level','organization_ids','official_url']); texts(row,['id','name','degree_level']); strings(row.organization_ids); source(row.official_url);
    if (!row.organization_ids.length || row.organization_ids.some(id=>!ids.has(id))) throw new Error('项目关联机构缺失');
  }
  return {...data,schema_version:'research-ecosystem/v2',centres};
}
