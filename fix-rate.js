const fs = require('fs');
let c = fs.readFileSync('bot.js', 'utf8');
const old = "lines.push('\u{1F4C8} \u041A\u0443\u0440\u0441: ' + data.cashRate.toLocaleString('ru-RU') + ' \u0441\u043E\u043C/\$')";
const rep = "lines.push('\u{1F4C8} \u041A\u0443\u0440\u0441: ' + data.cashRate.toLocaleString('ru-RU'))";
const count = (c.split(old).length - 1);
console.log('Found:', count);
c = c.split(old).join(rep);
fs.writeFileSync('bot.js', c, 'utf8');
console.log('done');
