const ExcelJS = require('exceljs');
async function main(){
  // 1) 缺列表头
  const wb1 = new ExcelJS.Workbook(); const ws1 = wb1.addWorksheet('s');
  ws1.addRow(['采样点','检测指标','单位','检测值']);
  ws1.addRow(['SP-001','PH','无量纲',7.1]);
  await wb1.xlsx.writeFile(require('path').join(__dirname,'..','uploads','bad_header.xlsx'));

  // 2) 完全空文件
  const wb2 = new ExcelJS.Workbook(); wb2.addWorksheet('s');
  await wb2.xlsx.writeFile(require('path').join(__dirname,'..','uploads','empty.xlsx'));

  // 3) 小样本（用于重试/取消测试）
  const wb3 = new ExcelJS.stream.xlsx.WorkbookWriter({filename:require('path').join(__dirname,'..','uploads','small.xlsx')});
  const ws3 = wb3.addWorksheet('数据上送');
  ws3.columns=[{header:'采样点',key:'a'},{header:'检测指标',key:'b'},{header:'单位',key:'c'},{header:'检测值',key:'d'},{header:'采样时间',key:'e'}];
  for(let i=0;i<3000;i++){
    ws3.addRow({a:'SP-001',b:'PH',c:'无量纲',d:7+Math.random()*2,e:'2026-09-20 10:'+String(i%60).padStart(2,'0')+':'+String(i%60).padStart(2,'0')}).commit();
  }
  await wb3.commit();
  console.log('done');
}
main();
