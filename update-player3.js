const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');
let changed = false;

// Step 2: Simplify stats display - use regex to be more flexible with whitespace
const statsRegex = /statEl\.innerHTML =\s*'<div class="pps-main"[^]*?'<div class="pps-row">\s*'\s*\+\s*'<span class="pps-icon">💯<\/span>'\s*\+\s*'<span class="pps-label">Score total<\/span>'\s*\+\s*'<span class="pps-value">'\s*\+\s*\(me\.score \|\| 0\)\s*\+\s*' pts<\/span>'\s*\+\s*'<\/div>';/;

const newStats = `statEl.innerHTML =
        '<div class="pps-main" style="color:' + pctColor + '">' + pct + '%</div>' +
        '<div class="pps-sub">de bonnes reponses</div>' +
        '<div class="pps-bar-wrap"><div class="pps-bar" style="width:' + pct + '%;background:' + pctColor + '"></div></div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">' + rankEmoji + '</span>' +
          '<span class="pps-label">Classement ' + rank + 'e/' + sorted.length + '</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + '</span>' +
        '</div>' +
        '<div class="pps-message" style="border-color:' + pctColor + '">' + encouragement + '</div>';`;

if (statsRegex.test(content)) {
  content = content.replace(statsRegex, newStats);
  console.log('✓ Simplified stats display (regex match)');
  changed = true;
} else {
  // Try a simpler approach - find and replace just the key parts
  const simplifiedFind = `        '<div class="pps-row">' +
          '<span class="pps-icon">💯</span>' +
          '<span class="pps-label">Score total</span>' +
          '<span class="pps-value">' + (me.score || 0) + ' pts</span>' +
        '</div>'`;
  
  if (content.includes(simplifiedFind)) {
    // Remove the Score total row and the "Bonnes réponses" row
    content = content.replace(
      `        '<div class="pps-row">' +
          '<span class="pps-icon">🎯</span>' +
          '<span class="pps-label">Bonnes réponses</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + ' — ' + pct + '%</span>' +
        '</div>' +`,
      ``
    );
    
    // Replace the Score total row with updated Classement
    content = content.replace(simplifiedFind, 
      `        '<div class="pps-row">' +
          '<span class="pps-icon">' + rankEmoji + '</span>' +
          '<span class="pps-label">Classement ' + rank + 'e/' + sorted.length + '</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + '</span>' +
        '</div>'`);
    
    console.log('✓ Simplified stats display (direct replaces)');
    changed = true;
  } else {
    console.log('⚠ Could not find stats HTML to replace');
  }
}

// Step 3: Add timer
const timerFind = `    showScreen('screen-podium');
  }`;

const timerReplace = `    showScreen('screen-podium');
    
    // Auto-transition après 30 secondes si final
    if (isFinal) {
      if (window.podiumTimeout) clearTimeout(window.podiumTimeout);
      window.podiumTimeout = setTimeout(() => {
        const currentScreen = getActiveScreenId();
        if (currentScreen === 'screen-podium') {
          returnToJoinScreen();
        }
      }, 30000);
    }
  }`;

if (content.includes(timerFind)) {
  // Only replace the one in showPodium, not others
  // Find it specifically after the statEl.style.display line
  const specificFind = `      statEl.style.display = 'flex';
    }

    showScreen('screen-podium');
  }`;
  
  const specificReplace = `      statEl.style.display = 'flex';
    }

    showScreen('screen-podium');
    
    // Auto-transition après 30 secondes si final
    if (isFinal) {
      if (window.podiumTimeout) clearTimeout(window.podiumTimeout);
      window.podiumTimeout = setTimeout(() => {
        const currentScreen = getActiveScreenId();
        if (currentScreen === 'screen-podium') {
          returnToJoinScreen();
        }
      }, 30000);
    }
  }`;
  
  if (content.includes(specificFind)) {
    content = content.replace(specificFind, specificReplace);
    console.log('✓ Added 30-second auto-transition timer');
    changed = true;
  } else {
    console.log('⚠ Could not find specific context for timer');
  }
}

if (changed) {
  fs.writeFileSync('player.js', content);
  console.log('\n✅ File updated successfully');
} else {
  console.log('\n⚠ Some changes may not have been applied');
}
