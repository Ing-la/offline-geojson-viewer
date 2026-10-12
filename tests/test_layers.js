// geojson-viewer 图层面板测试
//   命名 / 删除+撤销 / 换色 / 缩放取景 / 批量操作 / 属性弹窗内容
//
// 跑法：npm install && npm test
//
// leaflet 用替身挡掉，所以不需要真浏览器。替身会**真正回放** onEachFeature
// 和 style 回调 —— 否则弹窗内容和着色逻辑根本没被执行，断言会假绿。

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

// ── leaflet 替身 ──
const calls = [];
function chain(tag) {
  const f = function () { return chain(tag); };
  return new Proxy(f, {
    get(t, p) {
      if (p === 'then' || p === Symbol.toPrimitive || p === 'toString') return undefined;
      return function (...args) {
        calls.push({ tag, prop: String(p), strs: args.filter(a => typeof a === 'string') });
        return chain(tag);
      };
    },
    set() { return true; },
    apply() { return chain(tag); },
    construct() { return chain(tag); },
  });
}
const called = (prop) => calls.some(c => c.prop === prop);
const popups = () => calls.filter(c => c.prop === 'bindPopup').map(c => c.strs.join(' '));
const styles = () => calls.filter(c => c.prop === 'style').map(c => c.strs.join(' '));

// 关键：L.geoJSON 要真的逐要素回调 onEachFeature / style
function geoJSON(data, opts) {
  const fc = (data && data.type === 'Feature') ? { features: [data] } : data;
  const feats = (fc && fc.features) || [];
  const fake = {
    bindPopup: function (html) {
      calls.push({ tag: 'geojson', prop: 'bindPopup', strs: [String(html)] });
      return fake;
    },
  };
  if (opts && opts.onEachFeature) feats.forEach(f => opts.onEachFeature(f, fake));
  if (opts && opts.style) {
    feats.forEach(f => {
      const s = opts.style(f);
      calls.push({ tag: 'geojson', prop: 'style', strs: [JSON.stringify(s)] });
    });
  }
  return chain('geojsonLayer');
}

const L = new Proxy({}, {
  get(t, p) {
    if (p === 'geoJSON') return geoJSON;
    return chain(String(p));
  },
  set() { return true; },
});

const dom = new JSDOM(HTML, {
  url: 'http://localhost/', runScripts: 'dangerously',
  virtualConsole: new VirtualConsole(),
  beforeParse(w) { w.L = L; w.alert = () => {}; },
});
const w = dom.window, d = w.document;

const mkPoint = (n) => JSON.stringify({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature', properties: { name: 'F' + i },
    geometry: { type: 'Point', coordinates: [116 + i * 1e-3, 39 + i * 1e-3] },
  })),
});
const rows = () => [...d.querySelectorAll('#overlay .layer-row')];
const names = () => rows().map(r => r.querySelector('.lrow-name').textContent);
const lastRow = () => rows()[rows().length - 1];
const paste = (txt) => { d.getElementById('jsonInput').value = txt; w.renderText(); };
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const dismissPop = () => d.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
const popInput = () => d.querySelector('.lpop input[type=text]');
const rename = (text) => {
  const i = popInput(); i.value = text;
  i.dispatchEvent(new w.Event('change', { bubbles: true }));
};

setTimeout(() => {
  // ── 1. 粘贴图层要有区分度 ──
  paste(mkPoint(3));
  paste(mkPoint(5));
  check('两次粘贴各成一个图层', rows().length === 2, 'rows=' + rows().length);
  check('粘贴图层自动编号，不再重名',
    names()[0] === '粘贴 1' && names()[1] === '粘贴 2', names().join(' / '));

  // ── 2. 行结构 ──
  let rs = rows();
  check('每行有：显隐 / 色块 / 名称 / 数量 / 删除',
    !!rs[0].querySelector('input[type=checkbox]') &&
    !!rs[0].querySelector('.lrow-pick') &&
    !!rs[0].querySelector('.lrow-name') &&
    !!rs[0].querySelector('.cnt') &&
    !!rs[0].querySelector('.lrow-del'));
  check('行不是 <label>（否则点色块会连带切换显隐）',
    rs[0].tagName === 'DIV' && !rs[0].querySelector('label'));
  check('数量显示正确', rs[1].querySelector('.cnt').textContent === '5',
    rs[1].querySelector('.cnt').textContent);

  const before = rs[0].querySelector('input[type=checkbox]').checked;
  click(rs[0].querySelector('.lrow-pick'));
  check('点色块不会连带切换显隐',
    rows()[0].querySelector('input[type=checkbox]').checked === before);
  check('点色块打开图层设置浮窗', !!d.querySelector('.lpop'));

  // ── 3. 换色 ──
  const pop = d.querySelector('.lpop');
  check('浮窗里有名称输入框', !!pop.querySelector('input[type=text]'));
  const dots = pop.querySelectorAll('.grid .dot');
  check('浮窗里有 16 个预设色格', dots.length === 16, 'dots=' + dots.length);
  check('浮窗里有自定义取色', !!pop.querySelector('input[type=color]'));
  check('当前颜色被标为选中', pop.querySelector('.dot.on') !== null);
  calls.length = 0;
  click(dots[5]);
  check('换色会重设图层样式', called('setStyle'));
  check('换色后色块背景跟着更新',
    rows()[0].querySelector('.lrow-pick').style.background !== '');
  check('换色后浮窗里的选中态移动到这个色格',
    d.querySelector('.lpop .dot.on') === dots[5]);
  check('换色不会多出浮窗', d.querySelectorAll('.lpop').length === 1);

  // ── 4. 改名 ──
  rename('主干道路');
  check('改名生效', names()[0] === '主干道路', names()[0]);

  // ── 5. 收起浮窗 ──
  dismissPop();
  check('点浮窗外面会收起', d.querySelector('.lpop') === null);
  click(rows()[1].querySelector('.lrow-pick'));
  check('（前置）浮窗又打开了', !!d.querySelector('.lpop'));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Esc 收起浮窗', d.querySelector('.lpop') === null);

  // ── 6. 点名称 → 缩放到该图层 ──
  calls.length = 0;
  click(rows()[1].querySelector('.lrow-name'));
  check('点名称会取景（fitBounds 被调用）', called('fitBounds'));
  rows()[1].querySelector('input[type=checkbox]')
    .dispatchEvent(new w.Event('change', { bubbles: true }));
  check('（前置）第 2 个图层已隐藏',
    rows()[1].querySelector('input[type=checkbox]').checked === false);
  click(rows()[1].querySelector('.lrow-name'));
  check('点隐藏图层的名称会先把它显示出来',
    rows()[1].querySelector('input[type=checkbox]').checked === true);

  // ── 7. 删除 + 撤销 ──
  const n0 = rows().length;
  click(rows()[0].querySelector('.lrow-del'));
  check('删除后少了一行', rows().length === n0 - 1, 'rows=' + rows().length);
  check('剩下的是原来第 2 个（顺序对）', names()[0] === '粘贴 2', names()[0]);
  const tb = d.querySelector('.undo-toast');
  check('弹出带「撤销」的提示', !!tb && /撤销/.test(tb.textContent), tb && tb.textContent);
  click(tb.querySelector('a'));
  check('撤销后图层回来了', rows().length === n0, 'rows=' + rows().length);
  check('撤销后回到原来的位置（层级不变）', names()[0] === '主干道路', names()[0]);

  // ── 8. 卡片头：全显 / 全隐 / 适配 ──
  const head = d.querySelector('#overlay .ov-head');
  check('卡片头显示图层数', /图层 · 2/.test(head.textContent), head.textContent);
  const act = (label) =>
    [...head.querySelectorAll('.ov-act')].find(b => b.textContent === label);
  click(act('全隐'));
  check('全隐：所有复选框取消',
    rows().every(r => r.querySelector('input[type=checkbox]').checked === false));
  click(act('全显'));
  check('全显：所有复选框打勾',
    rows().every(r => r.querySelector('input[type=checkbox]').checked === true));
  calls.length = 0;
  click(act('适配'));
  check('适配：触发取景', called('fitBounds'));

  // ── 9. 清空 ──
  click([...d.querySelectorAll('.appbar .btn, .appbar label')]
    .find(el => /清空/.test(el.textContent)));
  check('清空后图层清空', rows().length === 0);
  check('清空后浮窗也收起', d.querySelector('.lpop') === null);

  // ── 10. 新建图层：颜色来自调色板，且真的用在了要素样式上 ──
  calls.length = 0;
  paste(mkPoint(2));
  check('清空后序号从头开始（粘贴 1）', names()[0] === '粘贴 1', names()[0]);
  check('新图层的要素样式用了调色板第一个颜色',
    styles().some(s => s.indexOf('#3498db') >= 0), styles().join(' | '));
  check('点要素没有面积填充色以外的东西（走的是点/面分支）',
    styles().some(s => /fillOpacity/.test(s) && !/dashArray/.test(s)),
    styles().join(' | '));

  // ── 11. 纯线图层：样式与色块都换一种形态 ──
  calls.length = 0;
  paste(JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [[116, 39], [117, 40]] },
    }],
  }));
  const lineRow = lastRow();
  check('纯线图层用细线色块',
    lineRow.querySelector('.lrow-pick').classList.contains('line-swatch'),
    lineRow.querySelector('.lrow-pick').className);
  check('线要素用虚线样式（走的是线分支）',
    styles().some(s => /dashArray/.test(s)), styles().join(' | '));
  check('点/面图层仍用实心色块',
    rows()[0].querySelector('.lrow-pick').classList.contains('swatch'));

  // ── 12. 不再有任何"坡度等级"的业务耦合 ──
  calls.length = 0;
  paste(JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: { slope_class: 2, 名称: '甲' },
      geometry: { type: 'Point', coordinates: [116, 39] },
    }],
  }));
  const ps = popups();
  check('属性弹窗照原样列出全部字段（不过滤、不翻译）',
    ps.some(p => /slope_class: 2/.test(p)) && ps.some(p => /名称: 甲/.test(p)),
    ps.join(' | '));
  check('弹窗里不再出现「坡度等级」这种业务措辞',
    !ps.some(p => /坡度/.test(p)), ps.join(' | '));
  check('界面上不再出现「坡度」',
    !/坡度/.test(d.getElementById('overlay').textContent));
  dismissPop();
  click(lastRow().querySelector('.lrow-pick'));
  check('任何图层都给色格（没有分类着色的特例）',
    d.querySelectorAll('.lpop .grid .dot').length === 16);

  // ── 13. 图层名不会被当 HTML 解析 ──
  const evil = '<img src=x onerror=1>';
  rename(evil);                       // 改动的是当前打开的那一行
  check('图层名原样显示为文本，不生成元素',
    lastRow().querySelector('.lrow-name').textContent === evil &&
    lastRow().querySelector('img') === null,
    lastRow().querySelector('.lrow-name').textContent);

  console.log('\n' + '='.repeat(42));
  console.log(pass + ' passed, ' + fail + ' failed');
  dom.window.close();
  process.exit(fail ? 1 : 0);
}, 250);
