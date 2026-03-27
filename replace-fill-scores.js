const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');

const oldLine = '      PlayerGame.showFillScores(results);';
const newLine = '      setGamePlayersStripVisible(false);';

if (content.includes(oldLine)) {
  content = content.replace(oldLine, newLine);
  fs.writeFileSync('player.js', content);
  console.log('✅ Replaced showFillScores with setGamePlayersStripVisible(false)');
} else {
  console.log('❌ Could not find showFillScores line');
}
