// ==== 00_core.js ====
// MondaPac Design System generator — Figma plugin (development plugin).
// Builds the complete MondaPac design system library in an empty Figma design file:
// variables (primitives → semantic, light/dark, desktop/touch), text and effect styles,
// icons, components with variants and properties, documentation pages and screen templates.
// Works on every Figma plan: when a collection cannot have a second mode (Starter plan),
// dark and touch values are created as parallel collections and can be merged later
// with the "Upgrade to modes" command.

/* eslint-disable no-undef */
const SPEC = {"version":"1.10.1","generated":"2026-10-08","primitives":[{"name":"amber/10","hex":"#FFFCF7"},{"name":"amber/20","hex":"#FFF8EF"},{"name":"amber/35","hex":"#FFF1E0"},{"name":"amber/75","hex":"#FBE3C4"},{"name":"amber/105","hex":"#F3D7B0"},{"name":"amber/145","hex":"#F2C894"},{"name":"amber/180","hex":"#F5B65C"},{"name":"amber/290","hex":"#E08A1E"},{"name":"amber/385","hex":"#C46A00"},{"name":"amber/515","hex":"#8F4A00"},{"name":"amber/565","hex":"#6B4A1F"},{"name":"amber/655","hex":"#4A3418"},{"name":"amber/725","hex":"#33240D"},{"name":"amber/775","hex":"#241A0D"},{"name":"amber/780","hex":"#211A10"},{"name":"blue/20","hex":"#F7F9FF"},{"name":"blue/25","hex":"#F3F6FC"},{"name":"blue/30","hex":"#F3F5F8"},{"name":"blue/35","hex":"#EEF3FD"},{"name":"blue/40","hex":"#EDF2FF"},{"name":"blue/45","hex":"#EAF1FB"},{"name":"blue/75","hex":"#DDE7F3"},{"name":"blue/80","hex":"#DCE6FB"},{"name":"blue/95","hex":"#D6E0F2"},{"name":"blue/120","hex":"#C9D7F5"},{"name":"blue/130","hex":"#C7D4F5"},{"name":"blue/165","hex":"#B9C9F2"},{"name":"blue/170","hex":"#B3C8FF"},{"name":"blue/225","hex":"#9DB4F0"},{"name":"blue/235","hex":"#8DB5F2"},{"name":"blue/240","hex":"#8FB0FF"},{"name":"blue/305","hex":"#7096FF"},{"name":"blue/440","hex":"#3D68E6"},{"name":"blue/465","hex":"#4A68B8"},{"name":"blue/490","hex":"#3159D4"},{"name":"blue/510","hex":"#1D4FD7"},{"name":"blue/550","hex":"#1A45BF"},{"name":"blue/555","hex":"#1B45BD"},{"name":"blue/575","hex":"#1F4E8C"},{"name":"blue/580","hex":"#173FB0"},{"name":"blue/620","hex":"#2C3F73"},{"name":"blue/625","hex":"#2B3F6B"},{"name":"blue/665","hex":"#26345A"},{"name":"blue/680","hex":"#22305A"},{"name":"blue/720","hex":"#13284A"},{"name":"blue/725","hex":"#1B2645"},{"name":"blue/735","hex":"#17263A"},{"name":"blue/745","hex":"#18213A"},{"name":"blue/750","hex":"#15213A"},{"name":"blue/775","hex":"#141B2C"},{"name":"blue/780","hex":"#0B1D2E"},{"name":"brown/60","hex":"#F6EADB"},{"name":"brown/180","hex":"#E4BB8E"},{"name":"brown/505","hex":"#865628"},{"name":"brown/730","hex":"#2F2419"},{"name":"coral/55","hex":"#FDE7E3"},{"name":"coral/205","hex":"#F4A595"},{"name":"coral/475","hex":"#B23F2E"},{"name":"coral/735","hex":"#3A1A16"},{"name":"green/30","hex":"#F1F8F3"},{"name":"green/40","hex":"#E7F6EC"},{"name":"green/60","hex":"#DDF2E5"},{"name":"green/95","hex":"#CFE6D7"},{"name":"green/210","hex":"#6CD49A"},{"name":"green/550","hex":"#12663A"},{"name":"green/630","hex":"#1F4A33"},{"name":"green/635","hex":"#1C4A30"},{"name":"green/730","hex":"#0F2E1D"},{"name":"green/765","hex":"#10221A"},{"name":"honey/40","hex":"#FFF0D6"},{"name":"honey/155","hex":"#F3C46A"},{"name":"honey/470","hex":"#9A5A08"},{"name":"honey/720","hex":"#33260F"},{"name":"lime/20","hex":"#F5FAEF"},{"name":"lime/130","hex":"#C8DDB0"},{"name":"lime/180","hex":"#A9D570"},{"name":"lime/245","hex":"#9DBB7A"},{"name":"lime/390","hex":"#6E8F45"},{"name":"lime/545","hex":"#3F6212"},{"name":"lime/600","hex":"#35511F"},{"name":"lime/745","hex":"#1A2812"},{"name":"neutral/0","hex":"#FFFFFF"},{"name":"neutral/15","hex":"#F9FAFB"},{"name":"neutral/25","hex":"#F5F6F8"},{"name":"neutral/45","hex":"#EEF0F3"},{"name":"neutral/50","hex":"#EBEEF2"},{"name":"neutral/60","hex":"#E8EBF0"},{"name":"neutral/75","hex":"#E3E6EB"},{"name":"neutral/130","hex":"#D0D5DD"},{"name":"neutral/165","hex":"#C3C9D3"},{"name":"neutral/295","hex":"#98A1B0"},{"name":"neutral/335","hex":"#8B95A6"},{"name":"neutral/340","hex":"#8A93A3"},{"name":"neutral/380","hex":"#7C8698"},{"name":"neutral/440","hex":"#6B7586"},{"name":"neutral/500","hex":"#5B6475"},{"name":"neutral/565","hex":"#4A525E"},{"name":"neutral/605","hex":"#3F4756"},{"name":"neutral/625","hex":"#3A4250"},{"name":"neutral/690","hex":"#2A303B"},{"name":"neutral/710","hex":"#262C36"},{"name":"neutral/720","hex":"#232933"},{"name":"neutral/725","hex":"#222833"},{"name":"neutral/730","hex":"#232830"},{"name":"neutral/755","hex":"#1B2029"},{"name":"neutral/775","hex":"#181C24"},{"name":"neutral/785","hex":"#161A21"},{"name":"neutral/790","hex":"#111827"},{"name":"neutral/825","hex":"#0E1116"},{"name":"olive/50","hex":"#EAF2DF"},{"name":"olive/165","hex":"#B6D68B"},{"name":"olive/515","hex":"#4C6A1C"},{"name":"olive/730","hex":"#1F2B14"},{"name":"purple/45","hex":"#F1ECFF"},{"name":"purple/225","hex":"#B9A6FF"},{"name":"purple/525","hex":"#5B3CC4"},{"name":"purple/730","hex":"#271E47"},{"name":"red/45","hex":"#FDEBEA"},{"name":"red/125","hex":"#F6C9C5"},{"name":"red/140","hex":"#F3C4C0"},{"name":"red/220","hex":"#F79A90"},{"name":"red/365","hex":"#F04438"},{"name":"red/425","hex":"#D92D20"},{"name":"red/500","hex":"#B42318"},{"name":"red/520","hex":"#A8231A"},{"name":"red/590","hex":"#7A2E28"},{"name":"red/690","hex":"#4F201C"},{"name":"red/745","hex":"#3B1512"},{"name":"teal/20","hex":"#F2FAF8"},{"name":"teal/45","hex":"#E6F4F1"},{"name":"teal/65","hex":"#DCEFEA"},{"name":"teal/130","hex":"#B7DDD5"},{"name":"teal/220","hex":"#5BCFB8"},{"name":"teal/525","hex":"#0B6B5C"},{"name":"teal/615","hex":"#1F4D45"},{"name":"teal/680","hex":"#143A34"},{"name":"teal/700","hex":"#123430"},{"name":"teal/705","hex":"#06352E"},{"name":"teal/740","hex":"#0F2925"}],"color":[{"name":"bg/page","light":"neutral/25","dark":"neutral/825","lightHex":"#F5F6F8","darkHex":"#0E1116","scopes":["FRAME_FILL"],"description":"Page background behind cards"},{"name":"bg/surface","light":"neutral/0","dark":"neutral/785","lightHex":"#FFFFFF","darkHex":"#161A21","scopes":["FRAME_FILL","SHAPE_FILL","STROKE_COLOR","TEXT_FILL"],"description":"Cards, sidebar, top bar"},{"name":"bg/subtle","light":"neutral/15","dark":"neutral/755","lightHex":"#F9FAFB","darkHex":"#1B2029","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Table header, card footers, hover"},{"name":"bg/muted","light":"neutral/45","dark":"neutral/720","lightHex":"#EEF0F3","darkHex":"#232933","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Document viewer, neutral fills"},{"name":"bg/selected","light":"blue/40","dark":"blue/725","lightHex":"#EDF2FF","darkHex":"#1B2645","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Active nav item, applied filter, selected segment"},{"name":"bg/row-selected","light":"blue/20","dark":"blue/745","lightHex":"#F7F9FF","darkHex":"#18213A","scopes":["FRAME_FILL"],"description":"Selected table row"},{"name":"bg/row-attention","light":"amber/10","dark":"amber/780","lightHex":"#FFFCF7","darkHex":"#211A10","scopes":["FRAME_FILL"],"description":"Rows that need action"},{"name":"bg/info-banner","light":"blue/35","dark":"blue/750","lightHex":"#EEF3FD","darkHex":"#15213A","scopes":["FRAME_FILL"],"description":"Info banner"},{"name":"border/default","light":"neutral/75","dark":"neutral/690","lightHex":"#E3E6EB","darkHex":"#2A303B","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Card and section borders"},{"name":"border/row","light":"neutral/45","dark":"neutral/725","lightHex":"#EEF0F3","darkHex":"#222833","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Row dividers"},{"name":"border/control","light":"neutral/130","dark":"neutral/625","lightHex":"#D0D5DD","darkHex":"#3A4250","scopes":["STROKE_COLOR","FRAME_FILL"],"description":"Secondary buttons, segmented controls"},{"name":"border/input","light":"neutral/340","dark":"neutral/440","lightHex":"#8A93A3","darkHex":"#6B7586","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Inputs, checkboxes (3:1 on surface)"},{"name":"border/info","light":"blue/120","dark":"blue/625","lightHex":"#C9D7F5","darkHex":"#2B3F6B","scopes":["STROKE_COLOR"],"description":"Info banner border"},{"name":"text/primary","light":"neutral/790","dark":"neutral/60","lightHex":"#111827","darkHex":"#E8EBF0","scopes":["TEXT_FILL","STROKE_COLOR","FRAME_FILL"],"description":"Headings, values"},{"name":"text/secondary","light":"neutral/605","dark":"neutral/165","lightHex":"#3F4756","darkHex":"#C3C9D3","scopes":["TEXT_FILL"],"description":"Body text, labels"},{"name":"text/muted","light":"neutral/500","dark":"neutral/295","lightHex":"#5B6475","darkHex":"#98A1B0","scopes":["TEXT_FILL","STROKE_COLOR"],"description":"Meta text, axis labels"},{"name":"text/link","light":"blue/555","dark":"blue/240","lightHex":"#1B45BD","darkHex":"#8FB0FF","scopes":["TEXT_FILL","STROKE_COLOR"],"description":"Links, selected tab"},{"name":"text/link-hover","light":"blue/580","dark":"blue/170","lightHex":"#173FB0","darkHex":"#B3C8FF","scopes":["TEXT_FILL"],"description":"Link hover"},{"name":"text/on-accent","light":"neutral/0","dark":"neutral/0","lightHex":"#FFFFFF","darkHex":"#FFFFFF","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Text and icons on primary"},{"name":"icon/default","light":"neutral/605","dark":"neutral/165","lightHex":"#3F4756","darkHex":"#C3C9D3","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Default icon colour"},{"name":"icon/muted","light":"neutral/500","dark":"neutral/295","lightHex":"#5B6475","darkHex":"#98A1B0","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Secondary icons"},{"name":"action/primary","light":"blue/510","dark":"blue/440","lightHex":"#1D4FD7","darkHex":"#3D68E6","scopes":["FRAME_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Primary button, focus, selection"},{"name":"action/primary-hover","light":"blue/550","dark":"blue/490","lightHex":"#1A45BF","darkHex":"#3159D4","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Primary button hover"},{"name":"action/primary-disabled","light":"blue/130","dark":"blue/665","lightHex":"#C7D4F5","darkHex":"#26345A","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Disabled primary button"},{"name":"focus/ring","light":"blue/510","dark":"blue/240","lightHex":"#1D4FD7","darkHex":"#8FB0FF","scopes":["STROKE_COLOR","EFFECT_COLOR"],"description":"Keyboard focus ring"},{"name":"status/success/bg","light":"green/40","dark":"green/730","lightHex":"#E7F6EC","darkHex":"#0F2E1D","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Success badge background"},{"name":"status/success/fg","light":"green/550","dark":"green/210","lightHex":"#12663A","darkHex":"#6CD49A","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR","FRAME_FILL"],"description":"Success text and icon"},{"name":"status/success/track","light":"green/60","dark":"green/635","lightHex":"#DDF2E5","darkHex":"#1C4A30","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Success ring track"},{"name":"status/info/bg","light":"blue/45","dark":"blue/720","lightHex":"#EAF1FB","darkHex":"#13284A","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Info badge background"},{"name":"status/info/fg","light":"blue/575","dark":"blue/235","lightHex":"#1F4E8C","darkHex":"#8DB5F2","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Info text and icon"},{"name":"status/attention/bg","light":"amber/35","dark":"amber/725","lightHex":"#FFF1E0","darkHex":"#33240D","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Attention badge background"},{"name":"status/attention/fg","light":"amber/515","dark":"amber/180","lightHex":"#8F4A00","darkHex":"#F5B65C","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Attention text and icon"},{"name":"status/attention/solid","light":"amber/385","dark":"amber/290","lightHex":"#C46A00","darkHex":"#E08A1E","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Attention meter fill, pips"},{"name":"status/attention/track","light":"amber/75","dark":"amber/655","lightHex":"#FBE3C4","darkHex":"#4A3418","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Attention meter track"},{"name":"status/attention/border","light":"amber/145","dark":"amber/565","lightHex":"#F2C894","darkHex":"#6B4A1F","scopes":["STROKE_COLOR"],"description":"Attention card border"},{"name":"status/attention/surface","light":"amber/20","dark":"amber/775","lightHex":"#FFF8EF","darkHex":"#241A0D","scopes":["FRAME_FILL"],"description":"Attention panel background"},{"name":"status/critical/bg","light":"red/45","dark":"red/745","lightHex":"#FDEBEA","darkHex":"#3B1512","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Critical badge background"},{"name":"status/critical/fg","light":"red/520","dark":"red/220","lightHex":"#A8231A","darkHex":"#F79A90","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Critical text and icon"},{"name":"status/critical/solid","light":"red/425","dark":"red/365","lightHex":"#D92D20","darkHex":"#F04438","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Urgent card border, red ring"},{"name":"status/critical/meter","light":"red/500","dark":"red/365","lightHex":"#B42318","darkHex":"#F04438","scopes":["SHAPE_FILL","FRAME_FILL"],"description":"Overdue meter fill"},{"name":"status/critical/track","light":"red/125","dark":"red/690","lightHex":"#F6C9C5","darkHex":"#4F201C","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Overdue meter track"},{"name":"status/critical/border","light":"red/140","dark":"red/590","lightHex":"#F3C4C0","darkHex":"#7A2E28","scopes":["STROKE_COLOR"],"description":"Destructive secondary button border"},{"name":"status/neutral/bg","light":"neutral/45","dark":"neutral/710","lightHex":"#EEF0F3","darkHex":"#262C36","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Neutral badge background"},{"name":"status/neutral/fg","light":"neutral/605","dark":"neutral/165","lightHex":"#3F4756","darkHex":"#C3C9D3","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Neutral text"},{"name":"cert/seller/fg","light":"teal/525","dark":"teal/220","lightHex":"#0B6B5C","darkHex":"#5BCFB8","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR","FRAME_FILL"],"description":"Seller-level certificate"},{"name":"cert/seller/bg","light":"teal/20","dark":"teal/740","lightHex":"#F2FAF8","darkHex":"#0F2925","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Seller certificate chip"},{"name":"cert/seller/border","light":"teal/130","dark":"teal/615","lightHex":"#B7DDD5","darkHex":"#1F4D45","scopes":["STROKE_COLOR"],"description":"Seller certificate chip border"},{"name":"cert/seller/tile","light":"teal/45","dark":"teal/700","lightHex":"#E6F4F1","darkHex":"#123430","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Teal identity tile"},{"name":"cert/manufacturer/fg","light":"neutral/605","dark":"neutral/165","lightHex":"#3F4756","darkHex":"#C3C9D3","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Manufacturer certificate"},{"name":"cert/manufacturer/bg","light":"neutral/0","dark":"neutral/785","lightHex":"#FFFFFF","darkHex":"#161A21","scopes":["FRAME_FILL"],"description":"Manufacturer chip"},{"name":"cert/manufacturer/border","light":"neutral/130","dark":"neutral/625","lightHex":"#D0D5DD","darkHex":"#3A4250","scopes":["STROKE_COLOR"],"description":"Manufacturer chip border"},{"name":"cert/vegan/fg","light":"lime/545","dark":"lime/180","lightHex":"#3F6212","darkHex":"#A9D570","scopes":["TEXT_FILL","SHAPE_FILL","STROKE_COLOR"],"description":"Vegan certificate"},{"name":"cert/vegan/bg","light":"lime/20","dark":"lime/745","lightHex":"#F5FAEF","darkHex":"#1A2812","scopes":["FRAME_FILL"],"description":"Vegan chip"},{"name":"cert/vegan/border","light":"lime/130","dark":"lime/600","lightHex":"#C8DDB0","darkHex":"#35511F","scopes":["STROKE_COLOR"],"description":"Vegan chip border"},{"name":"cert/vegan/self-declared-border","light":"lime/245","dark":"lime/390","lightHex":"#9DBB7A","darkHex":"#6E8F45","scopes":["STROKE_COLOR"],"description":"Self-declared chip, dashed"},{"name":"tile/purple-bg","light":"purple/45","dark":"purple/730","lightHex":"#F1ECFF","darkHex":"#271E47","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Identity tile: applications"},{"name":"tile/purple-fg","light":"purple/525","dark":"purple/225","lightHex":"#5B3CC4","darkHex":"#B9A6FF","scopes":["TEXT_FILL","SHAPE_FILL"],"description":"Identity tile text"},{"name":"thumb/meat-bg","light":"coral/55","dark":"coral/735","lightHex":"#FDE7E3","darkHex":"#3A1A16","scopes":["FRAME_FILL"],"description":"Product thumbnail: meat"},{"name":"thumb/meat-fg","light":"coral/475","dark":"coral/205","lightHex":"#B23F2E","darkHex":"#F4A595","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Meat glyph"},{"name":"thumb/poultry-bg","light":"honey/40","dark":"honey/720","lightHex":"#FFF0D6","darkHex":"#33260F","scopes":["FRAME_FILL"],"description":"Product thumbnail: poultry"},{"name":"thumb/poultry-fg","light":"honey/470","dark":"honey/155","lightHex":"#9A5A08","darkHex":"#F3C46A","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Poultry glyph"},{"name":"thumb/bakery-bg","light":"brown/60","dark":"brown/730","lightHex":"#F6EADB","darkHex":"#2F2419","scopes":["FRAME_FILL"],"description":"Product thumbnail: bakery"},{"name":"thumb/bakery-fg","light":"brown/505","dark":"brown/180","lightHex":"#865628","darkHex":"#E4BB8E","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Bakery glyph"},{"name":"thumb/pantry-bg","light":"olive/50","dark":"olive/730","lightHex":"#EAF2DF","darkHex":"#1F2B14","scopes":["FRAME_FILL"],"description":"Product thumbnail: pantry"},{"name":"thumb/pantry-fg","light":"olive/515","dark":"olive/165","lightHex":"#4C6A1C","darkHex":"#B6D68B","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Pantry glyph"},{"name":"thumb/other-bg","light":"neutral/50","dark":"neutral/730","lightHex":"#EBEEF2","darkHex":"#232830","scopes":["FRAME_FILL"],"description":"Product thumbnail: other"},{"name":"thumb/other-fg","light":"neutral/565","dark":"neutral/165","lightHex":"#4A525E","darkHex":"#C3C9D3","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Other glyph"},{"name":"chart/series-1","light":"blue/510","dark":"blue/305","lightHex":"#1D4FD7","darkHex":"#7096FF","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Main series"},{"name":"chart/series-1-soft","light":"blue/165","dark":"blue/620","lightHex":"#B9C9F2","darkHex":"#2C3F73","scopes":["SHAPE_FILL"],"description":"Past periods in bar charts"},{"name":"chart/split-2","light":"blue/225","dark":"blue/465","lightHex":"#9DB4F0","darkHex":"#4A68B8","scopes":["SHAPE_FILL"],"description":"Second part of a split bar"},{"name":"chart/compare","light":"neutral/380","dark":"neutral/335","lightHex":"#7C8698","darkHex":"#8B95A6","scopes":["STROKE_COLOR"],"description":"Comparison series (dashed)"},{"name":"chart/grid","light":"neutral/45","dark":"neutral/720","lightHex":"#EEF0F3","darkHex":"#232933","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Gridlines"},{"name":"chart/axis","light":"neutral/130","dark":"neutral/625","lightHex":"#D0D5DD","darkHex":"#3A4250","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Baseline"},{"name":"chart/meter-track","light":"blue/80","dark":"blue/680","lightHex":"#DCE6FB","darkHex":"#22305A","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Meter track, accent"},{"name":"chart/donut-track","light":"teal/65","dark":"teal/680","lightHex":"#DCEFEA","darkHex":"#143A34","scopes":["STROKE_COLOR","SHAPE_FILL"],"description":"Certificate donut track"},{"name":"chart/tooltip-bg","light":"neutral/790","dark":"neutral/60","lightHex":"#111827","darkHex":"#E8EBF0","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Chart tooltip background (inverse)"},{"name":"chart/tooltip-fg","light":"neutral/0","dark":"neutral/790","lightHex":"#FFFFFF","darkHex":"#111827","scopes":["TEXT_FILL"],"description":"Chart tooltip value"},{"name":"chart/tooltip-muted","light":"neutral/130","dark":"neutral/605","lightHex":"#D0D5DD","darkHex":"#3F4756","scopes":["TEXT_FILL"],"description":"Chart tooltip label"},{"name":"map/land","light":"blue/30","dark":"neutral/775","lightHex":"#F3F5F8","darkHex":"#181C24","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Map land"},{"name":"map/water","light":"blue/75","dark":"blue/735","lightHex":"#DDE7F3","darkHex":"#17263A","scopes":["SHAPE_FILL","STROKE_COLOR"],"description":"Map water"},{"name":"map/road","light":"neutral/75","dark":"neutral/690","lightHex":"#E3E6EB","darkHex":"#2A303B","scopes":["STROKE_COLOR"],"description":"Map roads"},{"name":"map/seller-pin","light":"blue/510","dark":"blue/305","lightHex":"#1D4FD7","darkHex":"#7096FF","scopes":["SHAPE_FILL"],"description":"Seller with open orders"},{"name":"map/courier","light":"teal/525","dark":"teal/220","lightHex":"#0B6B5C","darkHex":"#5BCFB8","scopes":["SHAPE_FILL"],"description":"Courier position"},{"name":"board/action-bg","light":"amber/20","dark":"amber/780","lightHex":"#FFF8EF","darkHex":"#211A10","scopes":["FRAME_FILL"],"description":"Needs action column"},{"name":"board/action-border","light":"amber/105","dark":"amber/655","lightHex":"#F3D7B0","darkHex":"#4A3418","scopes":["STROKE_COLOR"],"description":"Needs action column border"},{"name":"board/prep-bg","light":"blue/25","dark":"blue/775","lightHex":"#F3F6FC","darkHex":"#141B2C","scopes":["FRAME_FILL"],"description":"Preparing column"},{"name":"board/prep-border","light":"blue/95","dark":"blue/625","lightHex":"#D6E0F2","darkHex":"#2B3F6B","scopes":["STROKE_COLOR"],"description":"Preparing column border"},{"name":"board/ready-bg","light":"green/30","dark":"green/765","lightHex":"#F1F8F3","darkHex":"#10221A","scopes":["FRAME_FILL"],"description":"Ready column"},{"name":"board/ready-border","light":"green/95","dark":"green/630","lightHex":"#CFE6D7","darkHex":"#1F4A33","scopes":["STROKE_COLOR"],"description":"Ready column border"},{"name":"bg/scrim","light":null,"dark":null,"lightHex":"#11182780","darkHex":"#00000099","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Overlay behind drawers and modals; alpha is part of the value"},{"name":"bg/qr","light":"neutral/0","dark":"neutral/0","lightHex":"#FFFFFF","darkHex":"#FFFFFF","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"QR code plate; white in both themes"},{"name":"bg/auth-showcase-admin","light":"blue/780","dark":"blue/780","lightHex":"#0B1D2E","darkHex":"#0B1D2E","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Auth brand panel, Admin; dark in both themes"},{"name":"bg/auth-showcase-seller","light":"teal/705","dark":"teal/705","lightHex":"#06352E","darkHex":"#06352E","scopes":["FRAME_FILL","SHAPE_FILL"],"description":"Auth brand panel, Seller; dark in both themes"},{"name":"text/on-showcase","light":"neutral/0","dark":"neutral/0","lightHex":"#FFFFFF","darkHex":"#FFFFFF","scopes":["TEXT_FILL","FRAME_FILL","SHAPE_FILL"],"description":"Brand line on the Auth brand panel"},{"name":"text/on-showcase-muted","light":null,"dark":null,"lightHex":"#FFFFFFBD","darkHex":"#FFFFFFBD","scopes":["TEXT_FILL","STROKE_COLOR"],"description":"Secondary brand line on the Auth brand panel; alpha is part of the value"}],"dimension":[{"name":"space/0-5","desktop":2,"touch":2,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/1","desktop":4,"touch":4,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/1-5","desktop":6,"touch":6,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/2","desktop":8,"touch":8,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/2-5","desktop":10,"touch":10,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/3","desktop":12,"touch":12,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/3-5","desktop":14,"touch":14,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/4","desktop":16,"touch":16,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/4-5","desktop":18,"touch":18,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/5","desktop":20,"touch":20,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/6","desktop":24,"touch":24,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/7","desktop":28,"touch":28,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/8","desktop":32,"touch":32,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"space/10","desktop":40,"touch":40,"scopes":["GAP","WIDTH_HEIGHT"]},{"name":"radius/chip","desktop":6,"touch":6,"scopes":["CORNER_RADIUS"]},{"name":"radius/control","desktop":8,"touch":10,"scopes":["CORNER_RADIUS"]},{"name":"radius/card","desktop":12,"touch":12,"scopes":["CORNER_RADIUS"]},{"name":"radius/column","desktop":14,"touch":14,"scopes":["CORNER_RADIUS"]},{"name":"radius/pill","desktop":999,"touch":999,"scopes":["CORNER_RADIUS"]},{"name":"size/control-sm","desktop":32,"touch":44,"scopes":["WIDTH_HEIGHT"]},{"name":"size/control","desktop":36,"touch":48,"scopes":["WIDTH_HEIGHT"]},{"name":"size/control-lg","desktop":44,"touch":48,"scopes":["WIDTH_HEIGHT"]},{"name":"size/badge","desktop":22,"touch":24,"scopes":["WIDTH_HEIGHT"]},{"name":"size/icon","desktop":18,"touch":20,"scopes":["WIDTH_HEIGHT"]},{"name":"size/thumb","desktop":28,"touch":32,"scopes":["WIDTH_HEIGHT"]},{"name":"size/sidebar","desktop":248,"touch":248,"scopes":["WIDTH_HEIGHT"]},{"name":"size/sidebar-collapsed","desktop":72,"touch":72,"scopes":["WIDTH_HEIGHT"]},{"name":"size/topbar","desktop":64,"touch":64,"scopes":["WIDTH_HEIGHT"]},{"name":"border/width","desktop":1,"touch":1,"scopes":["STROKE_FLOAT"]},{"name":"border/width-strong","desktop":2,"touch":2,"scopes":["STROKE_FLOAT"]},{"name":"size/bottom-bar","desktop":64,"touch":64,"scopes":["WIDTH_HEIGHT"]},{"name":"size/topbar-phone","desktop":56,"touch":56,"scopes":["WIDTH_HEIGHT"]},{"name":"size/auth-card","desktop":400,"touch":400,"scopes":["WIDTH_HEIGHT"]},{"name":"size/dialog-sm","desktop":400,"touch":400,"scopes":["WIDTH_HEIGHT"]},{"name":"size/dialog-md","desktop":560,"touch":560,"scopes":["WIDTH_HEIGHT"]},{"name":"size/form-max","desktop":640,"touch":640,"scopes":["WIDTH_HEIGHT"]}],"type":[{"name":"Display/Hero","family":"IBM Plex Sans","style":"SemiBold","size":30,"lineHeight":38,"letterSpacing":-0.3,"case":null},{"name":"Heading/H1","family":"IBM Plex Sans","style":"SemiBold","size":24,"lineHeight":32,"letterSpacing":-0.24,"case":null},{"name":"Heading/H2","family":"IBM Plex Sans","style":"SemiBold","size":16,"lineHeight":22,"letterSpacing":0,"case":null},{"name":"Heading/Amount","family":"IBM Plex Sans","style":"SemiBold","size":26,"lineHeight":32,"letterSpacing":-0.2,"case":null},{"name":"Heading/Stat","family":"IBM Plex Sans","style":"SemiBold","size":22,"lineHeight":28,"letterSpacing":0,"case":null},{"name":"Body/Default","family":"IBM Plex Sans","style":"Regular","size":13.5,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Body/Medium","family":"IBM Plex Sans","style":"Medium","size":13.5,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Body/Strong","family":"IBM Plex Sans","style":"SemiBold","size":13.5,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Body/Small","family":"IBM Plex Sans","style":"Regular","size":12.5,"lineHeight":18,"letterSpacing":0,"case":null},{"name":"Body/Small Strong","family":"IBM Plex Sans","style":"SemiBold","size":12.5,"lineHeight":18,"letterSpacing":0,"case":null},{"name":"Caption/Default","family":"IBM Plex Sans","style":"Regular","size":12,"lineHeight":16,"letterSpacing":0,"case":null},{"name":"Caption/Strong","family":"IBM Plex Sans","style":"SemiBold","size":12,"lineHeight":16,"letterSpacing":0,"case":null},{"name":"Caption/Overline","family":"IBM Plex Sans","style":"SemiBold","size":11,"lineHeight":16,"letterSpacing":0.77,"case":"UPPER"},{"name":"Label/Button","family":"IBM Plex Sans","style":"SemiBold","size":13.5,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Label/Button Small","family":"IBM Plex Sans","style":"SemiBold","size":13,"lineHeight":18,"letterSpacing":0,"case":null},{"name":"Touch/Body","family":"IBM Plex Sans","style":"Regular","size":14,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Touch/Strong","family":"IBM Plex Sans","style":"Bold","size":14,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Touch/Button","family":"IBM Plex Sans","style":"SemiBold","size":15,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Touch/Title","family":"IBM Plex Sans","style":"Bold","size":15,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Mono/Default","family":"IBM Plex Mono","style":"Medium","size":13.5,"lineHeight":20,"letterSpacing":0,"case":null},{"name":"Mono/Small","family":"IBM Plex Mono","style":"Regular","size":11,"lineHeight":16,"letterSpacing":0,"case":null},{"name":"Mono/Touch","family":"IBM Plex Mono","style":"Medium","size":15,"lineHeight":20,"letterSpacing":0,"case":null}],"effects":[{"name":"Elevation/Floating","layers":[{"type":"DROP_SHADOW","rgba":[17,24,39,0.22],"x":0,"y":12,"blur":28,"spread":-8,"token":null},{"type":"DROP_SHADOW","rgba":[17,24,39,0.1],"x":0,"y":4,"blur":8,"spread":-4,"token":null}],"description":"Floating bulk action bar"},{"name":"Elevation/Document","layers":[{"type":"DROP_SHADOW","rgba":[17,24,39,0.1],"x":0,"y":1,"blur":2,"spread":0,"token":null},{"type":"DROP_SHADOW","rgba":[17,24,39,0.08],"x":0,"y":8,"blur":16,"spread":0,"token":null}],"description":"Document preview paper"},{"name":"Focus/Ring","layers":[{"type":"DROP_SHADOW","rgba":[255,255,255,1],"x":0,"y":0,"blur":0,"spread":2,"token":"bg/surface"},{"type":"DROP_SHADOW","rgba":[29,79,215,1],"x":0,"y":0,"blur":0,"spread":4,"token":"focus/ring"}],"description":"Keyboard focus ring: 2px gap + 2px blue"},{"name":"Ring/Urgent","layers":[{"type":"DROP_SHADOW","rgba":[253,235,234,1],"x":0,"y":0,"blur":0,"spread":3,"token":"status/critical/bg"}],"description":"Ring around urgent order card"}],"motion":{"duration/fast":120,"duration/base":160,"duration/slow":240}};
const ICONS = {"home":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"></path></svg>","inbox":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M22 12h-6l-2 3h-4l-2-3H2\"></path><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"></path></svg>","clipboard":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\"></rect><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"></path><path d=\"M12 11h4\"></path><path d=\"M12 16h4\"></path><path d=\"M8 11h.01\"></path><path d=\"M8 16h.01\"></path></svg>","package":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m7.5 4.27 9 5.15\"></path><path d=\"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z\"></path><path d=\"m3.3 7 8.7 5 8.7-5\"></path><path d=\"M12 22V12\"></path></svg>","store":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 9.5 5.5 4h13L20 9.5\"></path><path d=\"M4 9.5h16v1a2.7 2.7 0 0 1-5.3.7 2.7 2.7 0 0 1-5.4 0A2.7 2.7 0 0 1 4 10.5z\"></path><path d=\"M5.5 12.5V20h13v-7.5\"></path><path d=\"M10 20v-4.5h4V20\"></path></svg>","users":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"></path><circle cx=\"9\" cy=\"7\" r=\"4\"></circle><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"></path><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"></path></svg>","wallet":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\"></path><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\"></path></svg>","file-text":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"></path><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"></path><path d=\"M16 13H8\"></path><path d=\"M16 17H8\"></path></svg>","sliders":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 6h10\"></path><path d=\"M18 6h2\"></path><circle cx=\"16\" cy=\"6\" r=\"2\"></circle><path d=\"M4 12h4\"></path><path d=\"M12 12h8\"></path><circle cx=\"10\" cy=\"12\" r=\"2\"></circle><path d=\"M4 18h12\"></path><circle cx=\"18\" cy=\"18\" r=\"2\"></circle></svg>","shield-check":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10\"></path><path d=\"m9 12 2 2 4-4\"></path></svg>","undo":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 14 4 9l5-5\"></path><path d=\"M4 9h10.5a5.5 5.5 0 0 1 0 11H11\"></path></svg>","badge-check":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z\"></path><path d=\"m9 12 2 2 4-4\"></path></svg>","message":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"></path></svg>","help-circle":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\"></path><path d=\"M12 17h.01\"></path></svg>","panel-left":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect><path d=\"M9 3v18\"></path></svg>","search":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"8\"></circle><path d=\"m21 21-4.3-4.3\"></path></svg>","bell":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9\"></path><path d=\"M10.3 21a1.94 1.94 0 0 0 3.4 0\"></path></svg>","chevron-down":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m6 9 6 6 6-6\"></path></svg>","chevron-right":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m9 18 6-6-6-6\"></path></svg>","chevron-left":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m15 18-6-6 6-6\"></path></svg>","x":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18 6 6 18\"></path><path d=\"m6 6 12 12\"></path></svg>","plus":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 5v14\"></path><path d=\"M5 12h14\"></path></svg>","download":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"></path><path d=\"m7 10 5 5 5-5\"></path><path d=\"M12 15V3\"></path></svg>","columns":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"></rect><path d=\"M9 3v18\"></path><path d=\"M15 3v18\"></path></svg>","more-vertical":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"#3F4756\" stroke=\"none\"><circle cx=\"12\" cy=\"5\" r=\"1\"></circle><circle cx=\"12\" cy=\"12\" r=\"1\"></circle><circle cx=\"12\" cy=\"19\" r=\"1\"></circle></svg>","more-horizontal":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"#3F4756\" stroke=\"none\"><circle cx=\"5\" cy=\"12\" r=\"1\"></circle><circle cx=\"12\" cy=\"12\" r=\"1\"></circle><circle cx=\"19\" cy=\"12\" r=\"1\"></circle></svg>","check":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 6 9 17l-5-5\"></path></svg>","minus":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12h14\"></path></svg>","alert-circle":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M12 8v4\"></path><path d=\"M12 16h.01\"></path></svg>","alert-triangle":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\"></path><path d=\"M12 9v4\"></path><path d=\"M12 17h.01\"></path></svg>","clock":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M12 6v6l4 2\"></path></svg>","calendar":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"></rect><path d=\"M16 2v4\"></path><path d=\"M8 2v4\"></path><path d=\"M3 10h18\"></path></svg>","zap":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"#3F4756\" stroke=\"none\"><path d=\"M13 2 4 14h7l-1 8 9-12h-7z\"></path></svg>","volume":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z\"></path><path d=\"M16 9a5 5 0 0 1 0 6\"></path><path d=\"M19.4 18.4a9 9 0 0 0 0-12.8\"></path></svg>","arrow-up":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 19V5\"></path><path d=\"m5 12 7-7 7 7\"></path></svg>","arrow-down":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 5v14\"></path><path d=\"m19 12-7 7-7-7\"></path></svg>","arrow-left":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 12H5\"></path><path d=\"m12 19-7-7 7-7\"></path></svg>","arrow-right":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12h14\"></path><path d=\"m12 5 7 7-7 7\"></path></svg>","external-link":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15 3h6v6\"></path><path d=\"M10 14 21 3\"></path><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"></path></svg>","zoom-in":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"8\"></circle><path d=\"m21 21-4.3-4.3\"></path><path d=\"M11 8v6\"></path><path d=\"M8 11h6\"></path></svg>","zoom-out":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"8\"></circle><path d=\"m21 21-4.3-4.3\"></path><path d=\"M8 11h6\"></path></svg>","leaf":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z\"></path><path d=\"M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12\"></path></svg>","briefcase":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"7\" width=\"18\" height=\"13\" rx=\"2\"></rect><path d=\"M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"></path></svg>","ban":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"m4.9 4.9 14.2 14.2\"></path></svg>","printer":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 9V2h12v7\"></path><path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\"></path><rect x=\"6\" y=\"14\" width=\"12\" height=\"8\"></rect></svg>","truck":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\"></path><path d=\"M15 18H9\"></path><path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14\"></path><circle cx=\"17\" cy=\"18\" r=\"2\"></circle><circle cx=\"7\" cy=\"18\" r=\"2\"></circle></svg>","map-pin":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z\"></path><circle cx=\"12\" cy=\"10\" r=\"3\"></circle></svg>","star":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"#3F4756\" stroke=\"none\"><path d=\"m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z\"></path></svg>","file":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"></path><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"></path></svg>","send":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m22 2-7 20-4-9-9-4z\"></path><path d=\"M22 2 11 13\"></path></svg>","eye":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z\"></path><circle cx=\"12\" cy=\"12\" r=\"3\"></circle></svg>","info":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M12 16v-4\"></path><path d=\"M12 8h.01\"></path></svg>","circle":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"></circle></svg>","menu":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 6h16\"></path><path d=\"M4 12h16\"></path><path d=\"M4 18h16\"></path></svg>","eye-off":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7\"></path><path d=\"M14.1 14.2a3 3 0 0 1-4.2-4.2\"></path><path d=\"M17.5 17.5A10.4 10.4 0 0 1 12 19c-7 0-10-7-10-7a13.2 13.2 0 0 1 4.6-5.5\"></path><path d=\"m2 2 20 20\"></path></svg>","lock":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"></rect><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"></path></svg>","mail":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"></rect><path d=\"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7\"></path></svg>","key":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"7.5\" cy=\"15.5\" r=\"5.5\"></circle><path d=\"m21 2-9.6 9.6\"></path><path d=\"m15.5 7.5 3 3L22 7l-3-3\"></path></svg>","user":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"8\" r=\"5\"></circle><path d=\"M20 21a8 8 0 0 0-16 0\"></path></svg>","log-out":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"></path><path d=\"m16 17 5-5-5-5\"></path><path d=\"M21 12H9\"></path></svg>","copy":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"8\" y=\"8\" width=\"14\" height=\"14\" rx=\"2\"></rect><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"></path></svg>","smartphone":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"5\" y=\"2\" width=\"14\" height=\"20\" rx=\"2\"></rect><path d=\"M12 18h.01\"></path></svg>","trash":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 6h18\"></path><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"></path><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"></path></svg>","pencil":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z\"></path><path d=\"m15 5 4 4\"></path></svg>","refresh-cw":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"></path><path d=\"M21 3v5h-5\"></path><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"></path><path d=\"M8 16H3v5\"></path></svg>","globe":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"></path><path d=\"M2 12h20\"></path></svg>","product-meat":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6.2 8c2.6-3.2 8.4-3.6 11.3-.1 2.6 3.1 1.6 7.8-2.1 9.8-3.1 1.7-6.8 1-8.8-1.5-1.9-2.3-2.4-5.6-.4-8.2z\"></path><circle cx=\"15\" cy=\"11.2\" r=\"1.7\"></circle></svg>","product-poultry":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15.2 4.2a5 5 0 0 1 4.6 6.2c-.7 2.9-3.7 4.4-6.4 3.7l-3.1 3.1\"></path><path d=\"M15.2 4.2c-2.9.7-4.6 3.6-3.9 6.5l-3.1 3.1\"></path><path d=\"M10.3 17.2a1.9 1.9 0 1 1-2.6 2.5 1.9 1.9 0 1 1 .5-3.6\"></path></svg>","product-bakery":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4.5 13.6c0-4 3.4-6.6 7.5-6.6s7.5 2.6 7.5 6.6V17a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4.5 17z\"></path><path d=\"m9.2 10.4-1.4 3\"></path><path d=\"m12.7 10-1.4 3.4\"></path><path d=\"m16.1 10.6-1.3 2.8\"></path></svg>","product-pantry":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8.6 6.6h6.8l-1.4 2.6c2.9 1.5 4.5 4.2 4.5 6.9a3.4 3.4 0 0 1-3.4 3.4H8.9a3.4 3.4 0 0 1-3.4-3.4c0-2.7 1.6-5.4 4.5-6.9z\"></path><path d=\"M9.2 4.4h5.6\"></path><path d=\"M9.5 14.2h5\"></path></svg>","product-other":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#3F4756\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3.6c1 3 4.6 4.6 4.6 9.1a4.6 4.6 0 0 1-9.2 0c0-2 1-3.4 2-4.4.3 1.5 1 2.4 2 2.7-.5-2.8-.2-5.1.6-7.4z\"></path></svg>"};
const CONTRAST = [["light","text","text/primary","bg/page",16.41,4.5,true],["light","text","text/primary","bg/surface",17.74,4.5,true],["light","text","text/primary","bg/subtle",16.98,4.5,true],["light","text","text/primary","bg/muted",15.54,4.5,true],["light","text","text/primary","bg/selected",15.84,4.5,true],["dark","text","text/primary","bg/page",15.83,4.5,true],["dark","text","text/primary","bg/surface",14.6,4.5,true],["dark","text","text/primary","bg/subtle",13.67,4.5,true],["dark","text","text/primary","bg/muted",12.23,4.5,true],["dark","text","text/primary","bg/selected",12.46,4.5,true],["light","text","text/secondary","bg/page",8.64,4.5,true],["light","text","text/secondary","bg/surface",9.35,4.5,true],["light","text","text/secondary","bg/subtle",8.94,4.5,true],["light","text","text/secondary","bg/row-selected",8.88,4.5,true],["light","text","text/secondary","bg/row-attention",9.13,4.5,true],["dark","text","text/secondary","bg/page",11.36,4.5,true],["dark","text","text/secondary","bg/surface",10.48,4.5,true],["dark","text","text/secondary","bg/subtle",9.82,4.5,true],["dark","text","text/secondary","bg/row-selected",9.58,4.5,true],["dark","text","text/secondary","bg/row-attention",10.34,4.5,true],["light","text","text/muted","bg/page",5.51,4.5,true],["light","text","text/muted","bg/surface",5.96,4.5,true],["light","text","text/muted","bg/subtle",5.7,4.5,true],["dark","text","text/muted","bg/page",7.26,4.5,true],["dark","text","text/muted","bg/surface",6.7,4.5,true],["dark","text","text/muted","bg/subtle",6.27,4.5,true],["light","text","text/link","bg/surface",7.98,4.5,true],["light","text","text/link","bg/selected",7.12,4.5,true],["light","text","text/link","bg/info-banner",7.17,4.5,true],["dark","text","text/link","bg/surface",8.16,4.5,true],["dark","text","text/link","bg/selected",6.97,4.5,true],["dark","text","text/link","bg/info-banner",7.49,4.5,true],["light","text","text/on-accent","action/primary",6.66,4.5,true],["light","text","text/on-accent","action/primary-hover",7.93,4.5,true],["dark","text","text/on-accent","action/primary",4.86,4.5,true],["dark","text","text/on-accent","action/primary-hover",5.98,4.5,true],["light","badge","status/success/fg","status/success/bg",6.29,4.5,true],["dark","badge","status/success/fg","status/success/bg",8.06,4.5,true],["light","badge","status/info/fg","status/info/bg",7.31,4.5,true],["dark","badge","status/info/fg","status/info/bg",7.01,4.5,true],["light","badge","status/attention/fg","status/attention/bg",6.01,4.5,true],["dark","badge","status/attention/fg","status/attention/bg",8.38,4.5,true],["light","badge","status/critical/fg","status/critical/bg",6.25,4.5,true],["dark","badge","status/critical/fg","status/critical/bg",7.67,4.5,true],["light","badge","status/neutral/fg","status/neutral/bg",8.19,4.5,true],["dark","badge","status/neutral/fg","status/neutral/bg",8.43,4.5,true],["light","text","status/attention/fg","status/attention/surface",6.33,4.5,true],["light","text","status/attention/fg","bg/surface",6.67,4.5,true],["dark","text","status/attention/fg","status/attention/surface",9.55,4.5,true],["dark","text","status/attention/fg","bg/surface",9.74,4.5,true],["light","text","status/critical/fg","bg/surface",7.19,4.5,true],["dark","text","status/critical/fg","bg/surface",8.29,4.5,true],["light","text","status/success/fg","bg/surface",7.03,4.5,true],["dark","text","status/success/fg","bg/surface",9.57,4.5,true],["light","chip","cert/seller/fg","cert/seller/bg",6.05,4.5,true],["dark","chip","cert/seller/fg","cert/seller/bg",8.11,4.5,true],["light","chip","cert/manufacturer/fg","cert/manufacturer/bg",9.35,4.5,true],["dark","chip","cert/manufacturer/fg","cert/manufacturer/bg",10.48,4.5,true],["light","chip","cert/vegan/fg","cert/vegan/bg",6.67,4.5,true],["dark","chip","cert/vegan/fg","cert/vegan/bg",9.17,4.5,true],["light","tile","cert/seller/fg","cert/seller/tile",5.68,4.5,true],["dark","tile","cert/seller/fg","cert/seller/tile",7.09,4.5,true],["light","tile","tile/purple-fg","tile/purple-bg",6.3,4.5,true],["dark","tile","tile/purple-fg","tile/purple-bg",7.31,4.5,true],["light","glyph","thumb/meat-fg","thumb/meat-bg",4.86,3.0,true],["dark","glyph","thumb/meat-fg","thumb/meat-bg",7.96,3.0,true],["light","glyph","thumb/poultry-fg","thumb/poultry-bg",4.87,3.0,true],["dark","glyph","thumb/poultry-fg","thumb/poultry-bg",9.06,3.0,true],["light","glyph","thumb/bakery-fg","thumb/bakery-bg",5.25,3.0,true],["dark","glyph","thumb/bakery-fg","thumb/bakery-bg",8.5,3.0,true],["light","glyph","thumb/pantry-fg","thumb/pantry-bg",5.39,3.0,true],["dark","glyph","thumb/pantry-fg","thumb/pantry-bg",9.18,3.0,true],["light","glyph","thumb/other-fg","thumb/other-bg",6.78,3.0,true],["dark","glyph","thumb/other-fg","thumb/other-bg",8.9,3.0,true],["light","ui-boundary","border/input","bg/surface",3.1,3.0,true],["dark","ui-boundary","border/input","bg/surface",3.75,3.0,true],["light","focus","focus/ring","bg/surface",6.66,3.0,true],["light","focus","focus/ring","bg/page",6.16,3.0,true],["dark","focus","focus/ring","bg/surface",8.16,3.0,true],["dark","focus","focus/ring","bg/page",8.85,3.0,true],["light","graphic","chart/series-1","bg/surface",6.66,3.0,true],["dark","graphic","chart/series-1","bg/surface",6.23,3.0,true],["light","graphic","chart/compare","bg/surface",3.67,3.0,true],["dark","graphic","chart/compare","bg/surface",5.77,3.0,true],["light","graphic","status/critical/solid","bg/surface",4.83,3.0,true],["dark","graphic","status/critical/solid","bg/surface",4.64,3.0,true],["light","graphic","status/attention/solid","bg/surface",3.88,3.0,true],["dark","graphic","status/attention/solid","bg/surface",6.5,3.0,true],["light","graphic","map/seller-pin","map/land",6.1,3.0,true],["dark","graphic","map/seller-pin","map/land",6.09,3.0,true],["light","graphic","map/courier","map/land",5.88,3.0,true],["dark","graphic","map/courier","map/land",8.99,3.0,true],["light","text","chart/tooltip-fg","chart/tooltip-bg",17.74,4.5,true],["dark","text","chart/tooltip-fg","chart/tooltip-bg",14.84,4.5,true],["light","text","chart/tooltip-muted","chart/tooltip-bg",12.03,4.5,true],["dark","text","chart/tooltip-muted","chart/tooltip-bg",7.82,4.5,true],["light","icon","icon/default","bg/surface",9.35,3.0,true],["dark","icon","icon/default","bg/surface",10.48,3.0,true],["light","icon","icon/muted","bg/surface",5.96,3.0,true],["dark","icon","icon/muted","bg/surface",6.7,3.0,true],["light","text","text/on-showcase","bg/auth-showcase-admin",17.08,4.5,true],["light","text","text/on-showcase","bg/auth-showcase-seller",13.49,4.5,true],["dark","text","text/on-showcase","bg/auth-showcase-admin",17.08,4.5,true],["dark","text","text/on-showcase","bg/auth-showcase-seller",13.49,4.5,true],["light","text","text/on-showcase-muted","bg/auth-showcase-admin",9.82,4.5,true],["light","text","text/on-showcase-muted","bg/auth-showcase-seller",8.1,4.5,true],["dark","text","text/on-showcase-muted","bg/auth-showcase-admin",9.82,4.5,true],["dark","text","text/on-showcase-muted","bg/auth-showcase-seller",8.1,4.5,true]];
const PLUGIN_TAG = 'mondapac-ds';

const S = {
  modes: { color: false, dim: false },
  prim: {}, color: {}, colorDark: {}, dim: {}, dimTouch: {}, typeVars: {},
  colls: {}, ts: {}, es: {}, icons: {}, sets: {}, pending: [], fonts: {}, report: [], counts: { components: 0, variants: 0, instances: 0 },
};
const HEX = {}; const DARKHEX = {};
SPEC.color.forEach(function (c) { HEX[c.name] = c.lightHex; DARKHEX[c.name] = c.darkHex; });
const DIM = {}; const TOUCH = {}; SPEC.dimension.forEach(function (d) { DIM[d.name] = d.desktop; TOUCH[d.name] = d.touch; });

function log(msg) { S.report.push(msg); }
async function safe(label, fn) {
  try { return await fn(); } catch (e) { log('⚠ ' + label + ': ' + (e && e.message ? e.message : String(e))); return null; }
}
function tag(node) { try { node.setPluginData(PLUGIN_TAG, '1'); } catch (e) { /* ignore */ } return node; }
function rgb(hex) { const h = hex.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }; }
function rgba(hex, a) { const c = rgb(hex); c.a = a === undefined ? 1 : a; return c; }
function cssVar(prefix, name) { return 'var(--mp-' + (prefix ? prefix + '-' : '') + name.replace(/[\/\s]+/g, '-').toLowerCase() + ')'; }
async function flush() { const p = S.pending; S.pending = []; await Promise.all(p.map(function (x) { return x.catch(function (e) { log('⚠ style: ' + e.message); }); })); }

// ---------------------------------------------------------------- variables
function newCollection(name) { const c = figma.variables.createVariableCollection(name); S.colls[name] = c; return c; }
function tryAddMode(coll, name) { try { return coll.addMode(name); } catch (e) { return null; } }

// Adds one Dimension token to the collections described by S.dimModes (used by the build and by "Update library").
function addDimensionVariable(d) {
  const M = S.dimModes;
  const v = figma.variables.createVariable(d.name, M.collection, 'FLOAT');
  v.setValueForMode(M.desktop, d.desktop);
  if (M.touch) v.setValueForMode(M.touch, d.touch);
  v.scopes = d.scopes; v.setVariableCodeSyntax('WEB', cssVar('', d.name));
  S.dim[d.name] = v;
  if (M.touchCollection) {
    const t = figma.variables.createVariable(d.name, M.touchCollection, 'FLOAT');
    t.setValueForMode(M.touchAlt, d.touch); t.scopes = d.scopes; t.setVariableCodeSyntax('WEB', cssVar('', d.name));
    S.dimTouch[d.name] = t;
  }
}

// A colour value from #RRGGBB or #RRGGBBAA (the alpha byte becomes the colour's own alpha, e.g. bg/scrim).
function colorValue(hex) { const c = rgb(hex); if (hex.length > 7) c.a = parseInt(hex.slice(7, 9), 16) / 255; return c; }
// Adds one semantic colour token to the collections described by S.colorModes (used by the build and by "Update library").
// A token with a null light/dark primitive is a hex8 literal (alpha is part of the value), not an alias.
function addColorVariable(c) {
  const M = S.colorModes;
  function val(prim, hex) {
    if (!prim) return colorValue(hex);
    if (!S.prim[prim]) throw new Error('Primitive ' + prim + ' is missing for ' + c.name);
    return figma.variables.createVariableAlias(S.prim[prim]);
  }
  const v = figma.variables.createVariable(c.name, M.collection, 'COLOR');
  v.setValueForMode(M.light, val(c.light, c.lightHex));
  if (M.dark) v.setValueForMode(M.dark, val(c.dark, c.darkHex));
  v.scopes = c.scopes; v.description = c.description;
  v.setVariableCodeSyntax('WEB', cssVar('color', c.name));
  S.color[c.name] = v;
  if (M.darkCollection) {
    const d = figma.variables.createVariable(c.name, M.darkCollection, 'COLOR');
    d.setValueForMode(M.darkAlt, val(c.dark, c.darkHex));
    d.scopes = c.scopes; d.description = c.description + ' (dark)';
    d.setVariableCodeSyntax('WEB', cssVar('color', c.name));
    S.colorDark[c.name] = d;
  }
}

// Adds one primitive to the collection in S.primColl (used by the build and by "Update library", 1.7.0).
function addPrimitive(p) {
  const coll = S.primColl;
  const v = figma.variables.createVariable('color/' + p.name, coll, 'COLOR');
  v.setValueForMode(coll.modes[0].modeId, rgba(p.hex));
  v.scopes = [];
  v.description = p.hex + ' · step = 1000 × (1 − OKLab L)';
  S.prim[p.name] = v;
}

async function buildVariables() {
  // 1. Primitives (hidden from publishing, no scopes: designers use semantic tokens only)
  const prim = newCollection('Primitives');
  prim.renameMode(prim.modes[0].modeId, 'Value');
  await safe('hide primitives', function () { prim.hiddenFromPublishing = true; });
  S.primColl = prim;
  SPEC.primitives.forEach(addPrimitive);

  // 2. Semantic colour: Light + Dark (modes when the plan allows, otherwise a parallel collection)
  const color = newCollection('Color');
  color.renameMode(color.modes[0].modeId, 'Light');
  const lightMode = color.modes[0].modeId;
  const darkMode = tryAddMode(color, 'Dark');
  S.modes.color = !!darkMode;
  let dark = null; let darkModeAlt = null;
  if (!darkMode) {
    dark = newCollection('Color · Dark');
    dark.renameMode(dark.modes[0].modeId, 'Dark');
    darkModeAlt = dark.modes[0].modeId;
    log('ℹ Starter plan: one mode per collection. Dark values live in "Color · Dark". Run "Upgrade to modes" after upgrading the plan.');
  }
  S.colorModes = { collection: color, light: lightMode, dark: darkMode, darkCollection: dark, darkAlt: darkModeAlt };
  SPEC.color.forEach(addColorVariable);

  // 3. Dimension: Desktop + Touch density
  const dim = newCollection('Dimension');
  dim.renameMode(dim.modes[0].modeId, 'Desktop');
  const desk = dim.modes[0].modeId;
  const touch = tryAddMode(dim, 'Touch');
  S.modes.dim = !!touch;
  let dimT = null; let touchAlt = null;
  if (!touch) { dimT = newCollection('Dimension · Touch'); dimT.renameMode(dimT.modes[0].modeId, 'Touch'); touchAlt = dimT.modes[0].modeId; }
  S.dimModes = { collection: dim, desktop: desk, touch: touch, touchCollection: dimT, touchAlt: touchAlt };
  SPEC.dimension.forEach(addDimensionVariable);

  // 4. Typography variables (bound into text styles where the plan supports it)
  const ty = newCollection('Typography');
  ty.renameMode(ty.modes[0].modeId, 'Value');
  const tm = ty.modes[0].modeId;
  function tv(name, type, value, scopes) {
    const v = figma.variables.createVariable(name, ty, type); v.setValueForMode(tm, value); v.scopes = scopes;
    v.setVariableCodeSyntax('WEB', cssVar('font', name.replace(/^font\//, ''))); S.typeVars[name] = v; return v;
  }
  tv('font/family/sans', 'STRING', 'IBM Plex Sans', ['FONT_FAMILY']);
  tv('font/family/mono', 'STRING', 'IBM Plex Mono', ['FONT_FAMILY']);
  SPEC.type.forEach(function (t) {
    const key = t.name.toLowerCase().replace(/\s+/g, '-');
    if (!S.typeVars['font/size/' + key]) tv('font/size/' + key, 'FLOAT', t.size, ['FONT_SIZE']);
    if (!S.typeVars['font/line-height/' + key]) tv('font/line-height/' + key, 'FLOAT', t.lineHeight, ['LINE_HEIGHT']);
  });

  // 5. Motion (documentation + code syntax)
  const mo = newCollection('Motion');
  mo.renameMode(mo.modes[0].modeId, 'Value');
  Object.keys(SPEC.motion).forEach(function (k) {
    const v = figma.variables.createVariable(k, mo, 'FLOAT'); v.setValueForMode(mo.modes[0].modeId, SPEC.motion[k]); v.scopes = [];
    v.setVariableCodeSyntax('WEB', cssVar('motion', k)); v.description = SPEC.motion[k] + ' ms';
  });
  log('✓ Variables: ' + SPEC.primitives.length + ' primitives, ' + SPEC.color.length + ' colour tokens (light + dark), ' + SPEC.dimension.length + ' dimensions (desktop + touch).');
}

// ---------------------------------------------------------------- fonts & styles
const FONT_FALLBACK = { 'IBM Plex Sans': 'Inter', 'IBM Plex Mono': 'Roboto Mono' };
async function loadFonts() {
  const want = {};
  SPEC.type.forEach(function (t) { want[t.family + '|' + t.style] = { family: t.family, style: t.style }; });
  [['IBM Plex Sans', 'Regular'], ['IBM Plex Sans', 'Medium'], ['IBM Plex Sans', 'SemiBold'], ['IBM Plex Sans', 'Bold'], ['IBM Plex Mono', 'Regular'], ['IBM Plex Mono', 'Medium']]
    .forEach(function (f) { want[f[0] + '|' + f[1]] = { family: f[0], style: f[1] }; });
  const keys = Object.keys(want);
  for (let i = 0; i < keys.length; i++) {
    const f = want[keys[i]];
    const alt = f.style === 'SemiBold' ? 'Semi Bold' : (f.style === 'Semi Bold' ? 'SemiBold' : null);
    const fbFamily = FONT_FALLBACK[f.family] || 'Inter';
    const tries = [f, alt ? { family: f.family, style: alt } : null, { family: fbFamily, style: f.style === 'SemiBold' ? 'Semi Bold' : f.style }, { family: fbFamily, style: 'Regular' }].filter(Boolean);
    let ok = null;
    for (let j = 0; j < tries.length && !ok; j++) { try { await figma.loadFontAsync(tries[j]); ok = tries[j]; } catch (e) { /* try next */ } }
    if (!ok) throw new Error('No usable font for ' + f.family + ' ' + f.style);
    S.fonts[keys[i]] = ok;
    if (ok.family !== f.family) log('⚠ Font ' + f.family + ' ' + f.style + ' is not available; used ' + ok.family + ' ' + ok.style + '. Install IBM Plex and rebuild.');
  }
}
function font(family, style) { return S.fonts[family + '|' + style] || S.fonts['IBM Plex Sans|Regular']; }

// Binds the colour of each token layer of a spec effect. Figma's setBoundVariableForEffect returns the copy with spread 0
// (forum.figma.com/t/setboundvariableforeffect-bug/59788; the real file had Focus/Ring and Ring/Urgent at spread 0 until 1.8.4),
// so the spread is put back on the copy before the effects are set.
function bindEffectColours(layers, e) {
  return layers.map(function (fx, i) {
    const tk = e.layers[i].token;
    if (!tk) return fx;
    return Object.assign({}, figma.variables.setBoundVariableForEffect(fx, 'color', S.color[tk]), { spread: e.layers[i].spread });
  });
}
async function buildStyles() {
  // Font family variables hold the family actually loaded (fallback included), so bindings stay valid.
  const tm = S.colls.Typography.modes[0].modeId;
  S.typeVars['font/family/sans'].setValueForMode(tm, font('IBM Plex Sans', 'Regular').family);
  S.typeVars['font/family/mono'].setValueForMode(tm, font('IBM Plex Mono', 'Regular').family);
  for (let i = 0; i < SPEC.type.length; i++) {
    const t = SPEC.type[i];
    const st = figma.createTextStyle();
    st.name = t.name; st.fontName = font(t.family, t.style); st.fontSize = t.size;
    st.lineHeight = { unit: 'PIXELS', value: t.lineHeight };
    st.letterSpacing = { unit: 'PIXELS', value: t.letterSpacing || 0 };
    if (t.case === 'UPPER') st.textCase = 'UPPER';
    st.description = t.family + ' ' + t.style + ' · ' + t.size + '/' + t.lineHeight + (t.case ? ' · uppercase' : '');
    const key = t.name.toLowerCase().replace(/\s+/g, '-');
    await safe('bind type ' + t.name, function () {
      st.setBoundVariable('fontSize', S.typeVars['font/size/' + key]);
      st.setBoundVariable('lineHeight', S.typeVars['font/line-height/' + key]);
      st.setBoundVariable('fontFamily', S.typeVars[t.family === 'IBM Plex Mono' ? 'font/family/mono' : 'font/family/sans']);
    });
    tag(st); // 1.8.4: styles carry the plugin tag, so a later repair can tell them from a style of the same name made by hand
    S.ts[t.name] = st;
  }
  for (let ei = 0; ei < SPEC.effects.length; ei++) {
    const e = SPEC.effects[ei];
    const st = figma.createEffectStyle();
    st.name = e.name; st.description = e.description;
    const layers = e.layers.map(function (l) {
      return { type: 'DROP_SHADOW', color: { r: l.rgba[0] / 255, g: l.rgba[1] / 255, b: l.rgba[2] / 255, a: l.rgba[3] }, offset: { x: l.x, y: l.y }, radius: l.blur, spread: l.spread, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
    });
    st.effects = layers;
    // Focus and urgent rings take their colour from semantic variables, so they follow the theme.
    if (e.layers.some(function (l) { return l.token; })) {
      await safe('bind effect ' + e.name, function () { st.effects = bindEffectColours(layers, e); });
    }
    // Read the style back: a spread or a binding Figma did not keep shows here rather than as a missing ring later.
    const left = effectDiff(st.effects, e);
    if (left) log('⚠ effect style ' + e.name + ' differs from the spec after the build (' + left + '): fix it in the style editor by hand');
    tag(st);
    S.es[e.name] = st;
  }
  log('✓ Styles: ' + SPEC.type.length + ' text styles, ' + SPEC.effects.length + ' effect styles.');
}

// ---------------------------------------------------------------- node DSL
// Figma nodes are not extensible, so layout intent (sizing, absolute position) waits in a side table until add().
const META = new Map();
function setMeta(node, o) { if (o.sizeH || o.sizeV || o.abs || o.xy || o.truncate) META.set(node.id, { sizeH: o.sizeH, sizeV: o.sizeV, abs: o.abs, xy: o.xy, truncate: o.truncate }); return node; }
function paint(token, opacity) {
  if (!token) return null;
  let p;
  if (token.charAt(0) === '#') { p = { type: 'SOLID', color: rgb(token) }; if (opacity !== undefined) p.opacity = opacity; return p; }
  const v = S.color[token]; if (!HEX[token]) throw new Error('Unknown colour token ' + token);
  p = figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(HEX[token]) }, 'color', v);
  // Binding returns a paint with opacity 1, so the opacity is applied after binding.
  if (opacity !== undefined) p.opacity = opacity;
  return p;
}
function numVal(v) { if (typeof v !== 'string') return v; const x = S.touch ? TOUCH[v] : DIM[v]; if (x === undefined) throw new Error('Unknown dimension token ' + v); return x; }
function dimVar(name) { const v = (S.touch && !S.modes.dim) ? S.dimTouch[name] : S.dim[name]; if (!v) throw new Error('Unknown dimension token ' + name); return v; }
function touchMode(node) { if (!S.touch) return; try { node.setPluginData('density', 'touch'); } catch (e) { /* ignore */ } if (S.modes.dim) node.setExplicitVariableModeForCollection(S.dimModes.collection, S.dimModes.touch); }
function bindNum(node, field, v) {
  if (v === undefined || v === null) return;
  node[field] = numVal(v);
  if (typeof v === 'string') node.setBoundVariable(field, dimVar(v));
}
function radius(node, r) {
  if (r === undefined || r === null) return;
  if (typeof r === 'string') { ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (f) { bindNum(node, f, r); }); }
  else node.cornerRadius = r;
}
const ALIGN = { start: 'MIN', center: 'CENTER', end: 'MAX', baseline: 'BASELINE' };
const JUSTIFY = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };

function applyBox(f, o) {
  f.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  if (o.stroke) {
    f.strokes = [paint(o.stroke)]; f.strokeAlign = o.strokeAlign || 'INSIDE';
    if (o.sides) { const w = o.strokeW || 1; f.strokeTopWeight = o.sides.indexOf('top') >= 0 ? w : 0; f.strokeBottomWeight = o.sides.indexOf('bottom') >= 0 ? w : 0; f.strokeLeftWeight = o.sides.indexOf('left') >= 0 ? w : 0; f.strokeRightWeight = o.sides.indexOf('right') >= 0 ? w : 0; }
    else f.strokeWeight = o.strokeW || 1;
    if (o.dash) f.dashPattern = o.dash;
  }
  radius(f, o.radius);
  if (o.effect) { const es = S.es[o.effect]; if (es) S.pending.push(f.setEffectStyleIdAsync(es.id)); }
  if (o.opacity !== undefined) f.opacity = o.opacity;
}
function frame(o, children) {
  o = o || {};
  const f = figma.createFrame(); f.name = o.name || 'Frame';
  f.clipsContent = !!o.clip;
  applyBox(f, o);
  if (o.dir) {
    f.layoutMode = o.dir === 'H' ? 'HORIZONTAL' : 'VERTICAL';
    f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';
    if (o.wrap && o.dir === 'H') { f.layoutWrap = 'WRAP'; if (o.rowGap !== undefined) bindNum(f, 'counterAxisSpacing', o.rowGap); }
    const p = o.pad; let pt, pr, pb, pl;
    if (Array.isArray(p)) { pt = p[0]; pr = p[1]; pb = p[2]; pl = p[3]; } else { pt = pr = pb = pl = p; }
    if (o.px !== undefined) { pl = pr = o.px; } if (o.py !== undefined) { pt = pb = o.py; }
    bindNum(f, 'paddingTop', pt); bindNum(f, 'paddingRight', pr); bindNum(f, 'paddingBottom', pb); bindNum(f, 'paddingLeft', pl);
    if (o.gap === 'auto') f.primaryAxisAlignItems = 'SPACE_BETWEEN'; else bindNum(f, 'itemSpacing', o.gap);
    if (o.align) f.counterAxisAlignItems = ALIGN[o.align];
    if (o.justify) f.primaryAxisAlignItems = JUSTIFY[o.justify];
    if (o.w !== undefined || o.h !== undefined) {
      f.resize(numVal(o.w !== undefined ? o.w : 100), numVal(o.h !== undefined ? o.h : 100));
      if (o.w === undefined) f.layoutSizingHorizontal = 'HUG';
      if (o.h === undefined) f.layoutSizingVertical = 'HUG';
      if (typeof o.w === 'string') f.setBoundVariable('width', dimVar(o.w));
      if (typeof o.h === 'string') f.setBoundVariable('height', dimVar(o.h));
    }
  } else {
    f.layoutMode = 'NONE';
    f.resize(numVal(o.w || 100), numVal(o.h || 100));
  }
  // A frame that will FILL its parent starts FIXED (not HUG): FILL children inside a HUG frame would
  // otherwise freeze it at their natural width. It takes the parent's size when add() applies FILL.
  if (o.dir) {
    const fw = o.sizeH === 'FILL' && o.w === undefined, fh = o.sizeV === 'FILL' && o.h === undefined;
    if (fw || fh) {
      f.resize(fw ? 10 : f.width, fh ? 10 : f.height);
      if (!fw && o.w === undefined) f.layoutSizingHorizontal = 'HUG';
      if (!fh && o.h === undefined) f.layoutSizingVertical = 'HUG';
    }
  }
  if (o.minW) f.minWidth = o.minW;
  setMeta(f, { sizeH: o.sizeH, sizeV: o.sizeV, abs: o.abs });
  (children || []).forEach(function (c) { if (c) add(f, c); });
  return f;
}
function add(parent, child) {
  parent.appendChild(child);
  const m = META.get(child.id) || {}; META.delete(child.id);
  if (m.abs) { child.layoutPositioning = 'ABSOLUTE'; child.x = m.abs[0]; child.y = m.abs[1]; }
  if (parent.layoutMode && parent.layoutMode !== 'NONE' && !m.abs) {
    if (m.sizeH) { child.layoutSizingHorizontal = m.sizeH; if (child.type === 'TEXT' && m.sizeH === 'FILL' && child.textAutoResize !== 'HEIGHT') child.textAutoResize = 'HEIGHT'; }
    // Changing sizing resets truncation in Figma; re-apply single-line truncation afterwards.
    if (child.type === 'TEXT' && m.truncate) { child.textTruncation = 'ENDING'; child.maxLines = 1; }
    if (m.sizeV) child.layoutSizingVertical = m.sizeV;
  } else if (m.xy) { child.x = m.xy[0]; child.y = m.xy[1]; }
  return child;
}
function text(str, style, color, o) {
  o = o || {};
  const t = figma.createText();
  const spec = SPEC.type.filter(function (x) { return x.name === style; })[0];
  if (!spec) throw new Error('Unknown text style ' + style);
  t.fontName = font(spec.family, spec.style); t.fontSize = spec.size;
  t.lineHeight = { unit: 'PIXELS', value: spec.lineHeight };
  if (spec.case === 'UPPER') t.textCase = 'UPPER';
  t.characters = String(str);
  S.pending.push(t.setTextStyleIdAsync(S.ts[style].id));
  t.fills = [paint(color || 'text/primary')];
  t.name = o.name || String(str).slice(0, 40);
  if (o.align) t.textAlignHorizontal = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' }[o.align];
  if (o.w) { t.resize(o.w, t.height); t.textAutoResize = 'HEIGHT'; }
  if (o.truncate) { t.textAutoResize = 'HEIGHT'; t.textTruncation = 'ENDING'; t.maxLines = 1; }
  if (o.strike) t.textDecoration = 'STRIKETHROUGH';
  if (o.underline) t.textDecoration = 'UNDERLINE';
  setMeta(t, o);
  return t;
}
function rect(o) {
  const r = figma.createRectangle(); r.name = o.name || 'Rect';
  r.resize(numVal(o.w), numVal(o.h)); r.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  if (o.stroke) { r.strokes = [paint(o.stroke)]; r.strokeWeight = o.strokeW || 1; r.strokeAlign = 'INSIDE'; if (o.dash) r.dashPattern = o.dash; }
  radius(r, o.radius);
  if (typeof o.w === 'string') r.setBoundVariable('width', dimVar(o.w));
  if (typeof o.h === 'string') r.setBoundVariable('height', dimVar(o.h));
  setMeta(r, o);
  return r;
}
function ellipse(o) {
  const e = figma.createEllipse(); e.name = o.name || 'Ellipse'; e.resize(o.w, o.h || o.w);
  e.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  if (o.stroke) { e.strokes = [paint(o.stroke)]; e.strokeWeight = o.strokeW || 1; e.strokeAlign = o.strokeAlign || 'INSIDE'; if (o.cap) e.strokeCap = o.cap; }
  if (o.arc) e.arcData = o.arc;
  setMeta(e, o);
  return e;
}
// Normalise an absolute path ("M x y L x y C … Q … Z") so its bounding box starts at 0,0; returns offset.
function normPath(d) {
  const t = d.replace(/,/g, ' ').trim().split(/\s+/);
  let minx = Infinity, miny = Infinity; const nums = [];
  for (let i = 0; i < t.length; i++) { if (/^[A-Za-z]$/.test(t[i])) continue; nums.push(i); }
  for (let j = 0; j + 1 < nums.length; j += 2) { minx = Math.min(minx, +t[nums[j]]); miny = Math.min(miny, +t[nums[j + 1]]); }
  for (let j = 0; j + 1 < nums.length; j += 2) { t[nums[j]] = String(+(+t[nums[j]] - minx).toFixed(2)); t[nums[j + 1]] = String(+(+t[nums[j + 1]] - miny).toFixed(2)); }
  return { d: t.join(' '), x: minx, y: miny };
}
function vector(o) {
  const v = figma.createVector(); v.name = o.name || 'Vector';
  const np = normPath(o.d);
  v.vectorPaths = [{ windingRule: o.closed ? 'NONZERO' : 'NONE', data: np.d }];
  if (o.xy) o.xy = [o.xy[0] + np.x, o.xy[1] + np.y]; else o.xy = [np.x, np.y];
  v.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  v.strokes = o.stroke ? [paint(o.stroke)] : []; v.strokeWeight = o.strokeW || 2;
  v.strokeJoin = 'ROUND'; v.strokeCap = 'ROUND'; if (o.dash) v.dashPattern = o.dash;
  setMeta(v, o);
  return v;
}
function spacer(w, h) { const f = frame({ name: 'Spacer', w: w || 1, h: h || 1 }); f.fills = []; return f; }

// ==== 10_components_core.js ====
// ---------------------------------------------------------------- icons
function recolor(node, token) {
  const p = paint(token);
  const all = node.findAll ? node.findAll(function (n) { return n.type === 'VECTOR' || n.type === 'ELLIPSE' || n.type === 'RECTANGLE' || n.type === 'BOOLEAN_OPERATION' || n.type === 'LINE'; }) : [];
  all.forEach(function (n) {
    if (n.strokes && n.strokes.length) n.strokes = [p];
    if (n.fills && n.fills.length) n.fills = [p];
  });
}
// One icon component plus its cell on the Icons page (used by the build and by "Update library").
function iconCell(n) {
  const node = figma.createNodeFromSvg(ICONS[n]);
  node.name = 'Icon/' + n;
  node.findAll(function () { return true; }).forEach(function (c) { if ('constraints' in c) c.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; });
  const comp = figma.createComponentFromNode(node);
  comp.name = 'Icon/' + n; comp.fills = [];
  comp.description = n.indexOf('product-') === 0 ? 'Product category glyph (placeholder until real product photos).' : 'Line icon, 24px grid drawn at 20px. Colour comes from icon/* or status tokens.';
  recolor(comp, 'icon/default');
  S.icons[n] = comp;
  return frame({ name: n, dir: 'V', gap: 'space/2', align: 'center', pad: 'space/3', w: 120, radius: 'radius/control', fill: 'bg/subtle' }, [comp, text(n, 'Caption/Default', 'text/muted', { align: 'center' })]);
}
async function buildIcons(page) {
  const wrap = frame({ name: 'Icons', dir: 'H', wrap: true, gap: 'space/4', rowGap: 'space/4', pad: 'space/6', fill: 'bg/surface', radius: 'radius/card', stroke: 'border/default', w: 1360 });
  const names = Object.keys(ICONS);
  for (let i = 0; i < names.length; i++) add(wrap, iconCell(names[i]));
  S.counts.components += names.length;
  return wrap;
}
function icon(name, token, size) {
  const c = S.icons[name]; if (!c) throw new Error('Unknown icon ' + name);
  const i = c.createInstance(); i.name = 'icon-' + name;
  if (size && size !== 20) i.resize(size, size);
  if (token && token !== 'icon/default') recolor(i, token);
  S.counts.instances++;
  return i;
}

// ---------------------------------------------------------------- variant sets
function combos(axes) {
  const keys = Object.keys(axes); let out = [{}];
  keys.forEach(function (k) { const next = []; out.forEach(function (o) { axes[k].forEach(function (v) { const c = Object.assign({}, o); c[k] = v; next.push(c); }); }); out = next; });
  return out;
}
// Find layers that belong to this component itself: descend into frames, but not into nested instances
// (layers inside a nested instance cannot carry this component's property references).
function ownFind(root, pred) {
  const out = [];
  (function walk(n) { (n.children || []).forEach(function (c) { if (pred(c)) out.push(c); if (c.type !== 'INSTANCE') walk(c); }); })(root);
  return out;
}
function variantName(p) { return Object.keys(p).map(function (k) { return k + '=' + p[k]; }).join(', '); }

/**
 * makeSet(name, axes, build, opts)
 *  axes: { Variant: [...], Size: [...] }   build(component, props) fills one variant
 *  opts.text: [{ prop, node, def }]  opts.bool: [{ prop, node, def }]  opts.swap: [{ prop, node, def }]
 *  opts.width: wrap width   opts.desc: component description   opts.skip(props) → true to skip a combination
 */
function makeSet(name, axes, build, opts) {
  opts = opts || {};
  const list = combos(axes).filter(function (p) { return !(opts.skip && opts.skip(p)); });
  const comps = list.map(function (p) {
    const c = figma.createComponent(); c.name = variantName(p); c.fills = [];
    build(c, p);
    return c;
  });
  const set = figma.combineAsVariants(comps, figma.currentPage);
  set.name = name; set.description = opts.desc || '';
  gridVariants(set, axes, opts);
  set.fills = [paint('bg/surface')];
  set.strokes = [{ type: 'SOLID', color: rgb('#9747FF') }]; set.dashPattern = [6, 4]; set.strokeWeight = 1; set.cornerRadius = 16;
  const keys = {};
  (opts.text || []).forEach(function (t) {
    const k = set.addComponentProperty(t.prop, 'TEXT', t.def); keys[t.prop] = k;
    set.children.forEach(function (c) { ownFind(c, function (n) { return n.type === 'TEXT' && n.name === t.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { characters: k }); }); });
  });
  (opts.bool || []).forEach(function (b) {
    const k = set.addComponentProperty(b.prop, 'BOOLEAN', b.def); keys[b.prop] = k;
    set.children.forEach(function (c) { ownFind(c, function (n) { return n.name === b.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { visible: k }); }); });
  });
  (opts.swap || []).forEach(function (s) {
    const def = s.comp || S.icons[s.def];
    const k = set.addComponentProperty(s.prop, 'INSTANCE_SWAP', def.id); keys[s.prop] = k;
    set.children.forEach(function (c) { ownFind(c, function (n) { return n.type === 'INSTANCE' && n.name === s.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { mainComponent: k }); }); });
  });
  tag(set);
  S.sets[name] = { set: set, keys: keys, axes: Object.keys(axes) };
  S.counts.components++; S.counts.variants += comps.length;
  return set;
}
// Lay variants out as a grid: one column per value of the last axis (usually State; opts.colAxis picks another, 1.8.1), one row per
// combination of the other axes. Single-axis sets flow left to right and wrap at opts.width.
function gridVariants(set, axes, opts) {
  const keys = Object.keys(axes); const last = opts.colAxis && axes[opts.colAxis] ? opts.colAxis : keys[keys.length - 1];
  const PAD = 32, GX = opts.gapX || 24, GY = opts.gapY || 24, MAXW = opts.width || 1040;
  const kids = set.children.slice();
  const cells = [];
  if (keys.length > 1) {
    const rowIndex = {}; let rows = 0;
    kids.forEach(function (c) {
      const vp = c.variantProperties; const rk = keys.filter(function (k) { return k !== last; }).map(function (k) { return vp[k]; }).join('|');
      if (rowIndex[rk] === undefined) rowIndex[rk] = rows++;
      cells.push({ node: c, row: rowIndex[rk], col: axes[last].indexOf(vp[last]) });
    });
  } else {
    let x = 0, row = 0, col = 0;
    kids.forEach(function (c) {
      if (col > 0 && x + c.width > MAXW - 2 * PAD) { row++; col = 0; x = 0; }
      cells.push({ node: c, row: row, col: col }); x += c.width + GX; col++;
    });
  }
  const colW = [], rowH = [];
  cells.forEach(function (k) { colW[k.col] = Math.max(colW[k.col] || 0, k.node.width); rowH[k.row] = Math.max(rowH[k.row] || 0, k.node.height); });
  const colX = [], rowY = []; let acc = PAD;
  for (let i = 0; i < colW.length; i++) { colX[i] = acc; acc += (colW[i] || 0) + GX; }
  const totalW = acc - GX + PAD; acc = PAD;
  for (let j = 0; j < rowH.length; j++) { rowY[j] = acc; acc += (rowH[j] || 0) + GY; }
  const totalH = acc - GY + PAD;
  set.layoutMode = 'NONE';
  cells.forEach(function (k) { k.node.x = colX[k.col]; k.node.y = rowY[k.row] + Math.round(((rowH[k.row] || 0) - k.node.height) / 2); });
  set.resize(Math.max(totalW, 120), Math.max(totalH, 80));
}
// Single component (no variants) with optional properties
function makeComponent(name, build, opts) {
  opts = opts || {};
  const c = figma.createComponent(); c.name = name; c.fills = [];
  build(c);
  c.description = opts.desc || '';
  const keys = {};
  (opts.text || []).forEach(function (t) {
    const k = c.addComponentProperty(t.prop, 'TEXT', t.def); keys[t.prop] = k;
    ownFind(c, function (n) { return n.type === 'TEXT' && n.name === t.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { characters: k }); });
  });
  (opts.bool || []).forEach(function (b) {
    const k = c.addComponentProperty(b.prop, 'BOOLEAN', b.def); keys[b.prop] = k;
    ownFind(c, function (n) { return n.name === b.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { visible: k }); });
  });
  (opts.swap || []).forEach(function (s) {
    const def = s.comp || S.icons[s.def];
    const k = c.addComponentProperty(s.prop, 'INSTANCE_SWAP', def.id); keys[s.prop] = k;
    ownFind(c, function (n) { return n.type === 'INSTANCE' && n.name === s.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { mainComponent: k }); });
  });
  tag(c);
  S.sets[name] = { comp: c, keys: keys, axes: [] };
  S.counts.components++;
  return c;
}
// Compose a component's body: c is the ComponentNode; o is the frame options; children nodes
function body(c, o, children) {
  c.layoutMode = o.dir === 'V' ? 'VERTICAL' : 'HORIZONTAL';
  c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO';
  applyBox(c, o);
  const p = o.pad; let pt, pr, pb, pl;
  if (Array.isArray(p)) { pt = p[0]; pr = p[1]; pb = p[2]; pl = p[3]; } else { pt = pr = pb = pl = p; }
  if (o.px !== undefined) { pl = pr = o.px; } if (o.py !== undefined) { pt = pb = o.py; }
  bindNum(c, 'paddingTop', pt); bindNum(c, 'paddingRight', pr); bindNum(c, 'paddingBottom', pb); bindNum(c, 'paddingLeft', pl);
  if (o.gap === 'auto') c.primaryAxisAlignItems = 'SPACE_BETWEEN'; else bindNum(c, 'itemSpacing', o.gap);
  if (o.align) c.counterAxisAlignItems = ALIGN[o.align];
  if (o.justify) c.primaryAxisAlignItems = JUSTIFY[o.justify];
  if (o.w !== undefined || o.h !== undefined) {
    c.resize(numVal(o.w !== undefined ? o.w : 100), numVal(o.h !== undefined ? o.h : 100));
    if (o.w === undefined) c.layoutSizingHorizontal = 'HUG';
    if (o.h === undefined) c.layoutSizingVertical = 'HUG';
    if (typeof o.h === 'string') c.setBoundVariable('height', dimVar(o.h));
    if (typeof o.w === 'string') c.setBoundVariable('width', dimVar(o.w));
  }
  if (o.wrap) { c.layoutWrap = 'WRAP'; if (o.rowGap !== undefined) bindNum(c, 'counterAxisSpacing', o.rowGap); }
  c.clipsContent = !!o.clip;
  (children || []).forEach(function (ch) { if (ch) add(c, ch); });
  return c;
}

// ---------------------------------------------------------------- instances
function inst(name, props, o) {
  props = props || {}; o = o || {};
  const rec = S.sets[name]; if (!rec) throw new Error('Unknown component ' + name);
  let comp = rec.comp;
  if (rec.set) {
    const want = {}; rec.axes.forEach(function (a) { if (props[a] !== undefined) want[a] = props[a]; });
    comp = rec.set.children.filter(function (c) { return Object.keys(want).every(function (a) { return c.variantProperties[a] === want[a]; }); })[0];
    if (!comp) throw new Error('No variant of ' + name + ' matching ' + JSON.stringify(want));
  }
  const i = comp.createInstance(); S.counts.instances++;
  const set = {};
  Object.keys(props).forEach(function (k) {
    if (rec.axes.indexOf(k) >= 0) return;
    const key = rec.keys[k]; if (!key) throw new Error('Unknown property ' + k + ' on ' + name);
    let v = props[k];
    if (v && typeof v === 'object' && v.icon) v = S.icons[v.icon].id;
    else if (v && typeof v === 'object' && v.comp) v = v.comp.id;
    set[key] = v;
  });
  if (Object.keys(set).length) i.setProperties(set);
  if (o.name) i.name = o.name;
  setMeta(i, o);
  if (o.w) i.resize(o.w, i.height);
  return i;
}

// ---------------------------------------------------------------- documentation helpers
function para(str, w, color) { return text(str, 'Body/Default', color || 'text/secondary', { w: w || 640 }); }
function bullets(items, w) {
  return frame({ name: 'List', dir: 'V', gap: 'space/1-5' }, items.map(function (s) {
    return frame({ name: 'Item', dir: 'H', gap: 'space/2' }, [text('•', 'Body/Default', 'text/muted'), text(s, 'Body/Default', 'text/secondary', { w: (w || 360) - 16 })]);
  }));
}
function tableRow(r, widths, last) {
  return frame({ name: 'Row', dir: 'H', stroke: last ? null : 'border/row', sides: ['bottom'] }, r.map(function (cell, i) {
    if (cell && cell.type) { return frame({ name: 'Cell', dir: 'H', px: 'space/3', py: 'space/2', w: widths[i], align: 'center' }, [cell]); }
    return frame({ name: 'Cell', dir: 'H', px: 'space/3', py: 'space/2', w: widths[i] }, [text(String(cell), i === 0 ? 'Body/Medium' : 'Body/Small', i === 0 ? 'text/primary' : 'text/secondary', { w: widths[i] - 24 })]);
  }));
}
function table(cols, rows, widths) {
  const t = frame({ name: 'Table', dir: 'V', stroke: 'border/default', radius: 'radius/control', clip: true, fill: 'bg/surface' });
  add(t, frame({ name: 'Header', dir: 'H', fill: 'bg/subtle', stroke: 'border/default', sides: ['bottom'] }, cols.map(function (c, i) { return frame({ name: c, dir: 'H', px: 'space/3', py: 'space/2', w: widths[i] }, [text(c, 'Body/Small Strong', 'text/muted', { w: widths[i] - 24 })]); })));
  rows.forEach(function (r, ri) { add(t, tableRow(r, widths, ri === rows.length - 1)); });
  return t;
}
function pageShell(page, title, subtitle) {
  const root = frame({ name: title, dir: 'V', gap: 'space/10', pad: [64, 80, 96, 80], fill: 'bg/page', w: 1600 });
  add(root, frame({ name: 'Page header', dir: 'V', gap: 'space/3' }, [
    text('MondaPac Design System', 'Caption/Overline', 'text/link'),
    text(title, 'Display/Hero', 'text/primary'),
    subtitle ? para(subtitle, 960) : null,
  ]));
  page.appendChild(root); root.x = 0; root.y = 0;
  return root;
}
function docSection(root, title, desc) {
  const s = frame({ name: title, dir: 'V', gap: 'space/5', sizeH: 'FILL' }, [
    frame({ name: 'Section header', dir: 'V', gap: 'space/2', stroke: 'border/default', sides: ['top'], pad: [24, 0, 0, 0], sizeH: 'FILL' }, [
      text(title, 'Heading/H1', 'text/primary'), desc ? para(desc, 960) : null,
    ]),
  ]);
  add(root, s);
  return s;
}
// A component block: set (left) + doc panel (right)
const DOC_CONTENT_W = 1440; // page width 1600 less the 80 px side padding of pageShell
function blockIsWide(set) { return set.width + 24 + 360 > DOC_CONTENT_W; }
function usagePanelWidth(set, wide) { return wide ? Math.min(DOC_CONTENT_W, Math.max(Math.round(set.width), 720)) : 360; }
function componentBlock(root, set, doc) {
  const section = docSection(root, doc.title, doc.summary);
  // Usage notes sit to the right of the set; when the set is wide they move below it as columns.
  const wide = blockIsWide(set);
  const groups = [['When to use', doc.use], ['Properties', doc.props], ['Accessibility', doc.a11y], ['Avoid', doc.dont]].filter(function (g) { return g[1]; })
    .map(function (g) { return frame({ name: g[0], dir: 'V', gap: 'space/2', w: 312 }, [text(g[0], 'Heading/H2'), bullets(g[1], 312)]); });
  const panel = frame({ name: 'Usage', dir: wide ? 'H' : 'V', wrap: wide, gap: wide ? 'space/8' : 'space/4', rowGap: wide ? 'space/4' : undefined, pad: 'space/6', w: usagePanelWidth(set, wide), fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, groups);
  const row = frame({ name: 'Component + usage', dir: wide ? 'V' : 'H', gap: 'space/6', align: 'start' });
  row.appendChild(set);
  if (groups.length) add(row, panel); else panel.remove();
  add(section, row);
  return section;
}
// Update library: after a set changed size, put its block back the way componentBlock lays it out for that
// width (row direction, Usage panel direction, wrap and width). Returns true when something changed.
function fitBlock(set) {
  const row = set.parent; if (!row || row.type !== 'FRAME' || row.name !== 'Component + usage') return false;
  const wide = blockIsWide(set); let changed = false;
  const dir = wide ? 'VERTICAL' : 'HORIZONTAL';
  if (row.layoutMode !== dir) { row.layoutMode = dir; row.primaryAxisSizingMode = 'AUTO'; row.counterAxisSizingMode = 'AUTO'; changed = true; }
  const panel = row.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Usage'; })[0];
  if (panel) {
    const pdir = wide ? 'HORIZONTAL' : 'VERTICAL'; const w = usagePanelWidth(set, wide);
    if (panel.layoutMode !== pdir || Math.round(panel.width) !== w) {
      panel.layoutMode = pdir; panel.layoutWrap = wide ? 'WRAP' : 'NO_WRAP';
      bindNum(panel, 'itemSpacing', wide ? 'space/8' : 'space/4'); if (wide) bindNum(panel, 'counterAxisSpacing', 'space/4');
      panel.resize(w, panel.height); panel.layoutSizingHorizontal = 'FIXED'; panel.layoutSizingVertical = 'HUG';
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- additions to existing sets (Update library, 1.7.0)
// Wire the set's existing TEXT / BOOLEAN / INSTANCE_SWAP properties into a variant that was added later.
// opts uses the same { prop, node } lists as makeSet; keys come from the set's own definitions.
function wireVariant(c, keys, opts) {
  (opts.text || []).forEach(function (t) { const k = keys[t.prop]; if (!k) return; ownFind(c, function (n) { return n.type === 'TEXT' && n.name === t.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { characters: k }); }); });
  (opts.bool || []).forEach(function (b) { const k = keys[b.prop]; if (!k) return; ownFind(c, function (n) { return n.name === b.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { visible: k }); }); });
  (opts.swap || []).forEach(function (s) { const k = keys[s.prop]; if (!k) return; ownFind(c, function (n) { return n.type === 'INSTANCE' && n.name === s.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { mainComponent: k }); }); });
}
// Add the variants in `combos` that the set does not have yet, built by build(c, props) and wired to the
// set's properties. New variants are laid out in a block below the existing ones (rows by the other axes,
// columns by colAxis), so nothing that exists moves. Returns the new components.
function addVariants(rec, combos, build, opts, colAxis) {
  const set = rec.set; const have = {};
  set.children.forEach(function (c) { have[variantName(sortedProps(c.variantProperties, rec.axes))] = 1; });
  const made = [];
  combos.forEach(function (p) {
    const name = variantName(sortedProps(p, rec.axes)); if (have[name]) return;
    const c = figma.createComponent(); c.name = name; c.fills = [];
    build(c, p);
    set.appendChild(c); wireVariant(c, rec.keys, opts || {});
    made.push(c); have[name] = 1; S.counts.variants++;
  });
  if (made.length) placeBelow(set, made, colAxis);
  return made;
}
function sortedProps(p, axes) { const o = {}; axes.forEach(function (a) { if (p[a] !== undefined) o[a] = p[a]; }); return o; }
function placeBelow(set, comps, colAxis) {
  const PAD = 32, GX = 24, GY = 24; const fresh = new Set(comps.map(function (c) { return c.id; }));
  let top = 0, right = 0;
  set.children.forEach(function (c) { if (fresh.has(c.id)) return; top = Math.max(top, c.y + c.height); right = Math.max(right, c.x + c.width); });
  const rows = [], rowOf = {}, cols = [], colOf = {};
  comps.forEach(function (c) {
    const vp = c.variantProperties; const rk = Object.keys(vp).filter(function (k) { return k !== colAxis; }).map(function (k) { return vp[k]; }).join('|');
    if (rowOf[rk] === undefined) { rowOf[rk] = rows.length; rows.push(0); }
    const ck = vp[colAxis]; if (colOf[ck] === undefined) { colOf[ck] = cols.length; cols.push(0); }
    rows[rowOf[rk]] = Math.max(rows[rowOf[rk]], c.height); cols[colOf[ck]] = Math.max(cols[colOf[ck]], c.width);
  });
  const colX = []; let x = PAD; cols.forEach(function (w, i) { colX[i] = x; x += w + GX; });
  const rowY = []; let y = top + GY; rows.forEach(function (h, i) { rowY[i] = y; y += h + GY; });
  comps.forEach(function (c) {
    const vp = c.variantProperties; const rk = Object.keys(vp).filter(function (k) { return k !== colAxis; }).map(function (k) { return vp[k]; }).join('|');
    c.x = colX[colOf[vp[colAxis]]]; c.y = rowY[rowOf[rk]];
  });
  set.resize(Math.max(right, x - GX) + PAD, y - GY + PAD);
}

// ==== 20_foundations.js ====
// ---------------------------------------------------------------- foundation pages
function brandMark(size) {
  const f = frame({ name: 'MondaPac mark', w: size, h: size, radius: Math.round(size / 4), fill: 'action/primary' });
  f.layoutMode = 'HORIZONTAL'; f.primaryAxisAlignItems = 'CENTER'; f.counterAxisAlignItems = 'CENTER';
  add(f, text('M', size > 40 ? 'Display/Hero' : 'Heading/H2', 'text/on-accent'));
  return f;
}
function swatch(token, theme, w, h) {
  const r = figma.createRectangle(); r.name = token + ' · ' + theme; r.resize(w || 40, h || 40); r.cornerRadius = 8;
  const hex = theme === 'dark' ? DARKHEX[token] : HEX[token];
  let p = { type: 'SOLID', color: rgb(hex) };
  const v = theme === 'dark' ? (S.modes.color ? S.color[token] : S.colorDark[token]) : S.color[token];
  p = figma.variables.setBoundVariableForPaint(p, 'color', v);
  r.fills = [p]; r.strokes = [paint('border/default')]; r.strokeWeight = 1; r.strokeAlign = 'INSIDE';
  if (theme === 'dark') {
    // Wrapper frame carries the theme, so "Upgrade to modes" can switch it to the Dark mode later.
    const wrap = frame({ name: 'dark mode', w: w || 40, h: h || 40 }); wrap.fills = [];
    add(wrap, r); wrap.setPluginData('theme', 'dark'); setDarkModeOn(wrap); return wrap;
  }
  return r;
}
function primSwatch(p) {
  const r = figma.createRectangle(); r.name = p.name; r.resize(88, 56); r.cornerRadius = 8;
  r.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(p.hex) }, 'color', S.prim[p.name])];
  r.strokes = [paint('border/default')]; r.strokeWeight = 1; r.strokeAlign = 'INSIDE';
  return frame({ name: p.name, dir: 'V', gap: 'space/1', w: 88 }, [r, text(p.name.split('/')[1], 'Caption/Strong', 'text/primary'), text(p.hex, 'Mono/Small', 'text/muted')]);
}
function setDarkModeOn(node) {
  if (S.modes.color) node.setExplicitVariableModeForCollection(S.colorModes.collection, S.colorModes.dark);
}

async function pageCover(page) {
  const f = frame({ name: 'Cover', dir: 'V', gap: 'space/8', pad: [96, 96, 96, 96], w: 1600, h: 960, fill: 'bg/page', justify: 'between' });
  page.appendChild(f);
  add(f, frame({ name: 'Top', dir: 'H', gap: 'space/4', align: 'center' }, [brandMark(56), frame({ name: 'Brand', dir: 'V', gap: 'space/0-5' }, [text('MondaPac', 'Heading/Amount'), text('Marketplace platform · Brisbane, Australia', 'Body/Default', 'text/muted')])]));
  add(f, frame({ name: 'Title', dir: 'V', gap: 'space/4' }, [
    text('Design System', 'Caption/Overline', 'text/link'),
    text('Admin and Seller panels', 'Display/Hero'),
    para('One structure for both panels. Differences live in navigation, features and permissions — never in the look. Everything in this file is built from variables, styles and components; change the system here and every screen follows.', 880),
  ]));
  const meta = [['Version', SPEC.version], ['Updated', RELEASE.date], ['Themes', 'Light · Dark'], ['Density', 'Desktop · Touch'], ['Status', 'Stable foundation']];
  add(f, frame({ name: 'Meta', dir: 'H', gap: 'space/4' }, meta.map(function (m) {
    return frame({ name: m[0], dir: 'V', gap: 'space/1', pad: 'space/4', w: 220, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [text(m[0], 'Caption/Default', 'text/muted'), text(m[1], 'Heading/H2')]);
  })));
  tag(f);
}

async function pageGettingStarted(page) {
  const root = pageShell(page, 'Getting started', 'How this library is organised, how to use it, and how changes flow from Figma to code.');
  let s = docSection(root, 'Principles');
  add(s, frame({ name: 'Principles', dir: 'H', gap: 'space/4', wrap: true, rowGap: 'space/4', w: 1440 }, [
    ['One structure, two workspaces', 'Admin and Seller share the shell, templates and components. Only navigation items, features and permissions differ.'],
    ['Tokens, not values', 'Every colour, space, radius and size is a variable. Never type a hex value or a pixel size into a design.'],
    ['Accessible by default', 'WCAG 2.2 AA: text 4.5:1, UI boundaries 3:1, state never by colour alone, touch targets 44–48 px on tablet.'],
    ['Data first', 'Numbers, deadlines and status are the product. Show the comparison, the trend and the deadline next to every figure.'],
    ['Built for the counter', 'Sellers work on a tablet with busy hands: large targets, short labels, one decision per card.'],
    ['Light and dark', 'Every colour token has a light and a dark value. Check new work in both before handing it over.'],
  ].map(function (p) { return frame({ name: p[0], dir: 'V', gap: 'space/2', pad: 'space/6', w: 464, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [text(p[0], 'Heading/H2'), para(p[1], 416)]); })));

  s = docSection(root, 'File structure', 'Pages are grouped by separators. On the Starter plan (3 pages per file) each group is one page and each topic is a section on it. Foundations hold variables and styles, Components hold the library, Templates show full screens built only from components.');
  add(s, table(['Group', 'Pages', 'Contents'], [
    ['Start', 'Cover · Getting started · Changelog', 'What this is, how to use it, what changed'],
    ['Foundations', 'Colour · Typography · Spacing, size & radius · Elevation & motion · Icons · Accessibility', 'Variables, text styles, effect styles, icon components'],
    ['Components', 'Actions · Forms & selection · Status & feedback · Data display · Tables & collections · Navigation & shell · Review & detail · Board & delivery', 'Component sets with variants and properties, each with usage notes'],
    ['Templates', 'Admin · Seller · Auth · Dark preview', 'Full screens assembled from instances; the reference for new screens'],
    ['Workspace', 'Sandbox · Archive', 'Proposals in progress and retired components'],
  ], [180, 560, 600]));

  s = docSection(root, 'Naming', 'Names are the API between design and code. Keep them identical in Figma, in tokens and in components.');
  add(s, table(['Thing', 'Pattern', 'Example'], [
    ['Colour variable', 'role/name or role/state/part', 'bg/surface · text/muted · status/critical/fg'],
    ['Dimension variable', 'category/step', 'space/4 · radius/card · size/control'],
    ['Code syntax', 'var(--mp-…) set on every variable', 'var(--mp-color-text-muted)'],
    ['Text style', 'Group/Name', 'Body/Default · Heading/H1 · Mono/Default'],
    ['Component', 'PascalCase, matches the React component', 'Button · StatusBadge · OrderCard'],
    ['Variant property', 'Title Case keys, Title Case values', 'Variant=Primary, Size=Md, State=Hover'],
    ['Layers inside components', 'kebab-case', 'label · icon-leading · meter-fill'],
  ], [220, 420, 700]));

  s = docSection(root, 'How changes flow', 'Figma is the source of truth for the UI. Code follows through exported tokens and reviewed component changes.');
  add(s, frame({ name: 'Flow', dir: 'H', gap: 'space/3', align: 'center' }, [
    ['1 · Propose', 'Draft in Sandbox, link the ticket'], ['2 · Review', 'Design review: tokens only, all states, light + dark, a11y'], ['3 · Publish', 'Move to the library page, bump the version, write the changelog'],
    ['4 · Export', 'Run the plugin → Export tokens; commit docs/design/tokens'], ['5 · Build', 'Frontend updates components; QA checks against this file'],
  ].map(function (st, i, arr) {
    const card = frame({ name: st[0], dir: 'V', gap: 'space/1', pad: 'space/4', w: 248, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [text(st[0], 'Body/Strong'), text(st[1], 'Body/Small', 'text/muted', { w: 216 })]);
    return card;
  })));
  add(s, para('Plan note: on the Starter plan a collection has one mode and team libraries cannot be published. Dark and touch values are kept in parallel collections (Color · Dark, Dimension · Touch) and product screens live in this same file. After upgrading to Professional, run the plugin command "Upgrade to modes" and publish this file as a library.', 1200, 'text/muted'));
  tag(root);
}

// Release notes shown on the Changelog page, oldest first (new releases are appended in place). 1.1.0 to 1.4.0 were reserved for the planned
// Auth, Panel, Seller setup and Seller admin releases; that content now ships under the next free numbers, starting with 1.7.0 Auth.
const CHANGELOG_WIDTHS = [140, 160, 1100];
const RELEASES = [
  { version: '1.5.0', date: '7 Oct 2026', changes: 'Mobile navigation (D16). New components NavDrawer (phone drawer, Admin and Seller) and BottomTabBar (seller phone bar, 4 or 3 tabs). New token size/bottom-bar (64 px). Three 360 px phone templates: seller home with bottom bar, seller menu open, admin menu open.' },
  { version: '1.6.0', date: '7 Oct 2026', changes: 'Mobile navigation polish (D16 follow-up). New token bg/scrim (overlay colour with alpha in the value: #111827 at 50% light, black at 60% dark), new token size/topbar-phone (56 px), new icon menu, new component PhoneTopbar (Admin and Seller). The three phone templates use PhoneTopbar and the drawer scrim is bound to bg/scrim.' },
  { version: '1.7.0', date: '7 Oct 2026', changes: 'Auth (planned as 1.1.0 in identity ux.md 8.1). Tokens bg/qr, bg/auth-showcase-admin, bg/auth-showcase-seller, text/on-showcase, text/on-showcase-muted (white at 74%, hex8) and size/auth-card (400 px), with primitives blue/780 and teal/705. Icons eye-off, lock, mail, key, user, log-out, copy, smartphone, trash. New components BrandMark (the Sidebar uses it in a new build), Field, ReasonQuote, Menu and MenuItem, AuthShowcase. Input Type=Password and Type=Code; Button Variant=Link and State=Loading; ChecklistItem Waiting and Needs attention with Show actions and Action; Topbar Show search and Show notifications. Templates Auth (A1 to A11, Seller and Admin, 1280 and 360) and Seller · Your seller account (S1), with dark previews.' },
  { version: '1.8.0', date: '7 Oct 2026', changes: 'Panel (planned as 1.2.0 in the Panel spec). Tokens size/dialog-sm (400 px) and size/dialog-md (560 px). New components Select, Textarea, CheckboxRow, Toast, DialogBody and Dialog (6 variants: Size, Tone, Layout) and EmptyState (Page, Card, Compact). TableCell gains State=Loading (5 skeleton variants, added in place). The Field Control slot lists Input, Select and Textarea as preferred values. Templates Shared · Members, Roles, No access, Not found and Account security for Admin and Seller (1440 and 360), the dialogs D1 to D3 with the confirm dialogs and two phone sheets. The Sellers list, the role editor and dialogs D4 to D6 follow in 1.8.1.' },
  { version: '1.8.1', date: '7 Oct 2026', changes: 'Audit fixes for the Panel pages. Panel desktop pages are at least 900 px high, so the Sidebar holds its own items on short pages; the admin phone members screen shows the 3 cards that fit; the CheckboxRow set puts Value in columns and State in rows, so it no longer sticks out of its documentation row. Update library repairs the frames and the CheckboxRow set of a 1.8.0 file in place (nothing is deleted except the two member cards that did not fit). Update library no longer moves existing frames; overlaps are reported. No token, component or variant changes.' },
  { version: '1.8.2', date: '7 Oct 2026', changes: 'Layout fixes from the real-Figma Audit after 1.7.0. Input variants are laid out with Type in columns and AuthShowcase with one variant per row, so both sets and their documentation blocks fit the 1440 px page. On Starter files, a section that an update made larger no longer covers the sections after it: Update library moves an overlapping section past the one before it and leaves sections that do not overlap where they are. Nothing is renamed, rebuilt or deleted.' },
  { version: '1.8.3', date: '8 Oct 2026', changes: 'Panel follow-up (planned as 1.2.1 in the Panel spec), templates only. Admin · Sellers (Phase 2) with Menu open, View only, Loading, Empty and Load error, and its phone frame; the dialogs D4 Reject (with its error and the read-only View reason), D5 Suspend and D6 Add seller, and the Reject phone sheet; the role editor for Admin (Custom, Default, System, Duplicate, Errors) and Seller (Custom, Ready-made, Owner, New role) with the seller phone frame; the unsaved-changes dialog. Update library adds the 20 frames and 5 template bodies a file does not have yet, in rows below the existing frames, and changes nothing that exists. No token, component or variant changes.' },
  { version: '1.8.4', date: '8 Oct 2026', changes: 'Fixes from the 1.8.3 run in the real file. The Focus/Ring and Ring/Urgent effect styles get their spread back (2 and 4 px, 3 px): Figma had saved them with spread 0 when their colour was bound to a variable, so focus rings and the urgent ring did not show. The Main area of the plugin phone screens that clip their content (11 in a new build; not the phone role editor or the dialog sheets) scrolls vertically, so a list longer than the screen continues below the fold (the seller Members and Roles phone screens). Audit file lists 25 entries of each kind and counts the rest ("… and N more"), and checks that the effect styles match the spec, ring colours still bound. Update library repairs existing files in place.' },
  { version: '1.9.0', date: '8 Oct 2026', changes: 'Seller setup (planned as 1.3.0 in sellers ux.md 8.1). Token size/form-max (640 px, the widest form column). Icons pencil, refresh-cw, globe. New components FieldStatus (the status line under a field: Checking, Success, Info, Critical), DataRow (Single and Compare; Default, Missing, Blocked, Changed) and FormActionBar (Inline and Sticky; Clean, Dirty, Saving, Error). Field gains Show status (an exposed FieldStatus); Input gains Show prefix and Prefix (Type=Text); ChecklistItem gains Show detail, Detail and Show chevron. Templates Seller · Setup: S1 Your seller account in each seller state (8 frames), the steps S2 Business details, S3 Address and area, S4 Business number, S5 Shop web address and S6 Review and submit with their states, two state boards (S4 results, S5 statuses) and three phone frames. The 1.7.0 S1 frames stay as they are.' },
  { version: '1.10.0', date: '8 Oct 2026', changes: 'Seller admin (planned as 1.4.0 in sellers ux.md 8.1). New component SettingRow (one setting that saves on its own: Label, Description, Meta, Message, a Control slot for a Switch or a SegmentedControl; Default, Saving, Locked, Error). CheckboxRow gains State=Saving and Show undo (a reviewer check). Templates on Admin: Sellers (Phase 3) with tabs, kind, bulk selection and its 50 cap, empty states and a phone frame; Seller review (P3) for an application and a change request with every register state and each reason Approve is disabled; Seller detail (P2) with edit, history, banners and Admin-only settings (C1); Seller settings (P4); dialogs D3, D4 (three modes), D7, D8 and D10. On Seller: Store profile (S7) with a pending and a not accepted change, Staff, view only, languages and the minimum-order states, the dialogs D9 and the seller D3s, and phone frames. Two dark previews. No new token or icon.' },
  { version: '1.10.1', date: '8 Oct 2026', changes: 'Invitation expired on the admin Members list. The status Badge "Invitation expired" (Attention, clock icon) for an invitation past the expiry of its last mail, and the frame Shared · Members · Admin · Invitation expired: the expired row with its menu (Resend invitation, Cancel invitation…). Update library adds the frame to a file that lacks it, in a row below what Templates · Admin holds. The update report says "1 frame" and "1 template body" in the singular. No token, icon or component changes.' },
];
const RELEASE = RELEASES[RELEASES.length - 1];
async function pageChangelog(page) {
  const root = pageShell(page, 'Changelog', 'Semantic versioning: MAJOR for breaking renames or removals, MINOR for new components or variants, PATCH for fixes.');
  add(root, table(['Version', 'Date', 'Changes'], [
    ['1.0.0', '1 Oct 2026', 'First release. Foundations (variables light/dark, desktop/touch, text and effect styles, icons), the component library, Admin and Seller templates, dark preview.'],
  ].concat(RELEASES.map(function (r) { return [r.version, r.date, r.changes]; })), CHANGELOG_WIDTHS));
  tag(root);
}

async function pageColor(page) {
  const root = pageShell(page, 'Colour', 'Two layers. Primitives are raw values and are hidden from the library. Semantic tokens describe a role and switch between light and dark. Designs use semantic tokens only.');
  let s = docSection(root, 'Semantic tokens', 'Each row shows the light and dark value. Code syntax is set on every variable, so Dev Mode shows the CSS variable.');
  const groups = {};
  SPEC.color.forEach(function (c) { const g = c.name.split('/')[0]; (groups[g] = groups[g] || []).push(c); });
  Object.keys(groups).forEach(function (g) {
    add(s, text(g, 'Heading/H2'));
    const tbl = frame({ name: g, dir: 'V', stroke: 'border/default', radius: 'radius/card', fill: 'bg/surface', clip: true, w: 1440 });
    add(tbl, frame({ name: 'Header', dir: 'H', fill: 'bg/subtle', stroke: 'border/default', sides: ['bottom'], px: 'space/4', py: 'space/2', gap: 'space/4', sizeH: 'FILL' }, [
      text('Token', 'Body/Small Strong', 'text/muted', { w: 300 }), text('Light', 'Body/Small Strong', 'text/muted', { w: 180 }), text('Dark', 'Body/Small Strong', 'text/muted', { w: 180 }), text('Use', 'Body/Small Strong', 'text/muted', { w: 380 }), text('Code', 'Body/Small Strong', 'text/muted', { w: 300 }),
    ]));
    groups[g].forEach(function (c, i) {
      const darkCell = frame({ name: 'Dark', dir: 'H', gap: 'space/2', align: 'center', w: 180 }, [swatch(c.name, 'dark', 28, 28), text(c.darkHex, 'Mono/Small', 'text/muted')]);
      add(tbl, frame({ name: c.name, dir: 'H', px: 'space/4', py: 'space/2', gap: 'space/4', align: 'center', stroke: i < groups[g].length - 1 ? 'border/row' : null, sides: ['bottom'], sizeH: 'FILL' }, [
        text(c.name, 'Mono/Default', 'text/primary', { w: 300 }),
        frame({ name: 'Light', dir: 'H', gap: 'space/2', align: 'center', w: 180 }, [swatch(c.name, 'light', 28, 28), text(c.lightHex, 'Mono/Small', 'text/muted')]),
        darkCell,
        text(c.description, 'Body/Small', 'text/secondary', { w: 380 }),
        text(cssVar('color', c.name), 'Mono/Small', 'text/muted', { w: 300 }),
      ]));
    });
    add(s, tbl);
  });
  s = docSection(root, 'Primitives', 'Named by hue family and darkness step: step = 1000 × (1 − OKLab lightness). Higher numbers are darker. Not for direct use.');
  const fams = {};
  SPEC.primitives.forEach(function (p) { const f = p.name.split('/')[0]; (fams[f] = fams[f] || []).push(p); });
  Object.keys(fams).forEach(function (f) {
    add(s, frame({ name: f, dir: 'V', gap: 'space/2' }, [text(f, 'Heading/H2'), frame({ name: f + ' ramp', dir: 'H', gap: 'space/2', wrap: true, rowGap: 'space/3', w: 1440 }, fams[f].map(primSwatch))]));
  });
  tag(root);
}

async function pageTypography(page) {
  const root = pageShell(page, 'Typography', 'IBM Plex Sans for interface text, IBM Plex Mono for order numbers, certificate numbers and keyboard hints. Sizes and line heights are variables bound into the text styles.');
  const s = docSection(root, 'Text styles');
  SPEC.type.forEach(function (t) {
    add(s, frame({ name: t.name, dir: 'H', gap: 'space/8', align: 'center', py: 'space/3', stroke: 'border/row', sides: ['bottom'], w: 1440 }, [
      frame({ name: 'Spec', dir: 'V', gap: 'space/1', w: 320 }, [text(t.name, 'Body/Strong'), text(t.family + ' ' + t.style + ' · ' + t.size + ' / ' + t.lineHeight + (t.case ? ' · uppercase' : ''), 'Mono/Small', 'text/muted')]),
      text(t.name.indexOf('Mono') === 0 ? 'MP-10482 · Ctrl K' : (t.size >= 22 ? 'AUD 12,904.60' : 'Accept order MP-10482 before 2:50 pm'), t.name, 'text/primary', { w: 1000 }),
    ]));
  });
  tag(root);
}

const SIZE_USE = { 'size/control-sm': 'Row buttons', 'size/control': 'Buttons and inputs', 'size/control-lg': 'Tablet header controls', 'size/badge': 'Badges', 'size/icon': 'Icons', 'size/thumb': 'Product thumbnail in rows', 'size/sidebar': 'Sidebar width', 'size/sidebar-collapsed': 'Collapsed sidebar', 'size/topbar': 'Top bar height', 'size/bottom-bar': 'Phone bottom tab bar height (seller)', 'size/topbar-phone': 'Phone top bar height (Admin and Seller)', 'size/auth-card': 'Content width of the Auth form column', 'size/dialog-sm': 'Width of confirm, change-role, invite and add-seller dialogs, and of the Toast', 'size/dialog-md': 'Width of dialogs with a reason field', 'size/form-max': 'Widest form column (seller setup steps, store profile cards)', 'border/width': 'Default border', 'border/width-strong': 'Selected tab, urgent card' };
async function pageSpacing(page) {
  const root = pageShell(page, 'Spacing, size & radius', 'A 2 px base with 4 px steps for layout. Values switch between Desktop and Touch density; touch makes controls 48 px.');
  let s = docSection(root, 'Spacing');
  SPEC.dimension.filter(function (d) { return d.name.indexOf('space/') === 0; }).forEach(function (d) {
    add(s, frame({ name: d.name, dir: 'H', gap: 'space/4', align: 'center' }, [text(d.name, 'Mono/Default', 'text/primary', { w: 160 }), rect({ name: 'bar', w: d.name, h: 16, fill: 'action/primary', radius: 2 }), text(d.desktop + ' px', 'Body/Small', 'text/muted')]));
  });
  s = docSection(root, 'Radius');
  add(s, frame({ name: 'Radius', dir: 'H', gap: 'space/6' }, SPEC.dimension.filter(function (d) { return d.name.indexOf('radius/') === 0; }).map(function (d) {
    return frame({ name: d.name, dir: 'V', gap: 'space/2', align: 'center' }, [rect({ name: 'sample', w: 96, h: 64, fill: 'bg/selected', stroke: 'action/primary', radius: d.name }), text(d.name, 'Mono/Small', 'text/primary'), text(d.desktop === 999 ? 'pill' : d.desktop + ' px (touch ' + d.touch + ')', 'Caption/Default', 'text/muted')]);
  })));
  s = docSection(root, 'Sizes', 'Desktop and touch values. On the Starter plan touch values are in the "Dimension · Touch" collection.');
  add(s, table(['Token', 'Desktop', 'Touch', 'Use'], SPEC.dimension.filter(function (d) { return d.name.indexOf('size/') === 0 || d.name.indexOf('border/') === 0; }).map(function (d) {
    const use = SIZE_USE[d.name] || '';
    return [d.name, d.desktop + ' px', d.touch + ' px', use];
  }), [260, 160, 160, 600]));
  tag(root);
}

async function pageElevation(page) {
  const root = pageShell(page, 'Elevation & motion', 'The interface is flat: borders separate surfaces. Shadows are reserved for things that float above the page.');
  let s = docSection(root, 'Effect styles');
  add(s, frame({ name: 'Effects', dir: 'H', gap: 'space/8', pad: 'space/8', fill: 'bg/page' }, SPEC.effects.map(function (e) {
    return frame({ name: e.name, dir: 'V', gap: 'space/3', align: 'center' }, [frame({ name: 'sample', w: 200, h: 120, fill: 'bg/surface', radius: 'radius/card', effect: e.name, stroke: 'border/default' }), text(e.name, 'Body/Strong'), text(e.description, 'Caption/Default', 'text/muted', { w: 200, align: 'center' })]);
  })));
  s = docSection(root, 'Motion', 'Short and purposeful. With prefers-reduced-motion every movement becomes instant.');
  add(s, table(['Token', 'Value', 'Use'], [
    ['duration/fast', '120 ms', 'Hover and press colour changes'], ['duration/base', '160 ms', 'Bulk action bar in and out, tab change'], ['duration/slow', '240 ms', 'Order card moving between board columns'], ['easing (code only)', 'cubic-bezier(0.2, 0, 0, 1)', 'Standard easing for all movement'],
  ], [280, 260, 700]));
  tag(root);
}

async function pageIcons(page, iconsWrap) {
  const root = pageShell(page, 'Icons', 'Line icons on a 24 px grid, drawn at 20 px with a 1.75 px stroke. Swap icons through the Icon property on components; colour them with icon, text or status tokens.');
  const s = docSection(root, 'Library');
  add(s, iconsWrap);
  tag(root);
}

async function pageA11y(page) {
  const root = pageShell(page, 'Accessibility', 'WCAG 2.2 AA is the floor. Every pair below was measured for both themes.');
  let s = docSection(root, 'Contrast', 'Text needs 4.5:1. Icons, chart marks, focus rings and input borders need 3:1.');
  const rows = CONTRAST.filter(function (c, i) { return i % 1 === 0; }).map(function (c) { return [c[0], c[2] + ' on ' + c[3], c[1], c[4] + ':1', c[5] + ':1', c[6] ? 'Pass' : 'Fail']; });
  add(s, table(['Theme', 'Pair', 'Kind', 'Ratio', 'Needs', 'Result'], rows, [100, 520, 140, 120, 120, 120]));
  s = docSection(root, 'Rules');
  add(s, bullets([
    'Never show state by colour alone: badges carry a dot, a progress ring or an icon, and a word.',
    'Focus: every interactive component has a Focus state using the Focus/Ring effect (2 px gap + 2 px ring).',
    'Touch: tablet actions are 48 px high; nothing interactive is smaller than 24 × 24 px (WCAG 2.5.8).',
    'Timers update every 60 seconds and are not announced; only crossing a threshold is announced.',
    'Charts and maps have a text alternative and a "View as table" option in code.',
    'Logical layout: build with auto layout and start/end alignment so the UI can mirror for RTL.',
  ], 1100));
  tag(root);
}

// ==== 30_components.js ====
// ---------------------------------------------------------------- component library
function focusRing(node) { S.pending.push(node.setEffectStyleIdAsync(S.es['Focus/Ring'].id)); }
function withTouch(on, fn) { const prev = S.touch; S.touch = on; try { return fn(); } finally { S.touch = prev; } }
const TONE = {
  Success: ['status/success/bg', 'status/success/fg'], Info: ['status/info/bg', 'status/info/fg'], Attention: ['status/attention/bg', 'status/attention/fg'],
  Critical: ['status/critical/bg', 'status/critical/fg'], Neutral: ['status/neutral/bg', 'status/neutral/fg'],
};
function dot(token, size) { return ellipse({ name: 'dot', w: size || 6, fill: token }); }
// Progress ring used in status badges: 0 = dotted outline, 100 = filled
function progressRing(token, pct) {
  const f = frame({ name: 'progress', w: 10, h: 10 }); f.fills = [];
  const o = ellipse({ name: 'outline', w: 10, fill: null, stroke: token, strokeW: 1.5, xy: [0, 0] });
  if (pct === 0) o.dashPattern = [1.5, 1.5];
  add(f, o);
  if (pct > 0) {
    const a = ellipse({ name: 'fill', w: 10, fill: token, xy: [0, 0] });
    if (pct < 100) a.arcData = { startingAngle: -Math.PI / 2, endingAngle: -Math.PI / 2 + Math.PI * 2 * pct / 100, innerRadius: 0 };
    add(f, a);
  }
  return f;
}
function sparkPath(vals, w, h) {
  const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  const pts = vals.map(function (v, i) { return [i * ((w - 2) / (vals.length - 1)) + 1, (h - 3) - ((v - mn) / ((mx - mn) || 1)) * (h - 8)]; });
  const line = 'M ' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L ');
  const e = pts[pts.length - 1];
  return { line: line, area: line + ' L ' + e[0].toFixed(1) + ' ' + h + ' L 1 ' + h + ' Z', end: e };
}
function sparkline(vals, w, h, token) {
  const f = frame({ name: 'sparkline', w: w, h: h }); f.fills = [];
  const sp = sparkPath(vals, w, h);
  add(f, vector({ name: 'area', d: sp.area, fill: token, fillOpacity: 0.1, closed: true, xy: [0, 0] }));
  add(f, vector({ name: 'line', d: sp.line, stroke: token, strokeW: 2, xy: [0, 0] }));
  const d = ellipse({ name: 'end', w: 6, fill: token, stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [sp.end[0] - 3, sp.end[1] - 3] }); add(f, d);
  f.children.forEach(function (n) { n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; });
  return f;
}

// Button (release 1.7.0 adds Variant=Link and State=Loading). Top level, so "Update library" can add the new variants.
const BTN = {
  Primary: { Default: ['action/primary', null, 'text/on-accent'], Hover: ['action/primary-hover', null, 'text/on-accent'], Focus: ['action/primary', null, 'text/on-accent'], Disabled: ['action/primary-disabled', null, 'text/on-accent'] },
  Secondary: { Default: ['bg/surface', 'border/control', 'text/primary'], Hover: ['bg/subtle', 'border/control', 'text/primary'], Focus: ['bg/surface', 'border/control', 'text/primary'], Disabled: ['bg/surface', 'border/default', 'text/muted'] },
  Destructive: { Default: ['bg/surface', 'status/critical/border', 'status/critical/fg'], Hover: ['status/critical/bg', 'status/critical/border', 'status/critical/fg'], Focus: ['bg/surface', 'status/critical/border', 'status/critical/fg'], Disabled: ['bg/surface', 'border/default', 'text/muted'] },
  Ghost: { Default: [null, null, 'text/link'], Hover: ['bg/subtle', null, 'text/link'], Focus: [null, null, 'text/link'], Disabled: [null, null, 'text/muted'] },
  Link: { Default: [null, null, 'text/link'], Hover: [null, null, 'text/link-hover'], Focus: [null, null, 'text/link'], Disabled: [null, null, 'text/muted'] },
};
const BTN_SIZE = { Sm: ['size/control-sm', 'space/3', 'Label/Button Small', false], Md: ['size/control', 'space/3-5', 'Label/Button', false], Touch: ['size/control', 'space/4', 'Touch/Button', true] };
const BUTTON_AXES = { Variant: ['Primary', 'Secondary', 'Destructive', 'Ghost', 'Link'], Size: ['Sm', 'Md', 'Touch'], State: ['Default', 'Hover', 'Focus', 'Disabled', 'Loading'] };
const BUTTON_OPTS = { width: 1180, desc: 'Actions. Primary: one per area. Secondary: supporting actions. Destructive: irreversible actions, label ends with … and opens a confirmation. Ghost: low-emphasis actions like Clear. Link (1.7.0): a text action in a sentence or under a form, such as "Forgot password?"; no padding, underlined on hover. State=Loading (1.7.0): the Default colours with a spinner in place of the leading icon, at the same width; the form is read-only while it shows.',
  text: [{ prop: 'Label', node: 'label', def: 'Button' }], bool: [{ prop: 'Leading icon', node: 'icon-leading', def: false }, { prop: 'Trailing icon', node: 'icon-trailing', def: false }], swap: [{ prop: 'Icon', node: 'icon-leading', def: 'plus' }] };
// A 16 px spinner: a faint full ring and a 270° arc, both strokes in the label colour.
function spinner(token) {
  const f = frame({ name: 'spinner', w: 16, h: 16 }); f.fills = [];
  const ring = ellipse({ name: 'track', w: 12, fill: null, stroke: token, strokeW: 2, strokeAlign: 'CENTER', xy: [2, 2] }); ring.opacity = 0.3; add(f, ring);
  add(f, vector({ name: 'arc', d: 'M 8 2 C 11.314 2 14 4.686 14 8 C 14 11.314 11.314 14 8 14 C 4.686 14 2 11.314 2 8', stroke: token, strokeW: 2, xy: [0, 0] }));
  return f;
}
function buttonVariant(c, p) {
  const loading = p.State === 'Loading';
  const t = BTN[p.Variant][loading ? 'Default' : p.State]; const z = BTN_SIZE[p.Size]; const link = p.Variant === 'Link';
  // text/link-hover is a text colour only, so the icons of a hovered Link stay text/link.
  const ic = t[2] === 'text/link-hover' ? 'text/link' : t[2];
  withTouch(z[3], function () {
    const kids = loading ? [spinner(t[2]), text('Button', z[2], t[2], { name: 'label' })]
      : [icon('plus', ic, 16), text('Button', z[2], t[2], { name: 'label', underline: link && p.State === 'Hover' }), icon('chevron-down', ic, 16)];
    body(c, { dir: 'H', h: z[0], px: link ? 0 : z[1], gap: 'space/1-5', align: 'center', justify: 'center', fill: t[0], stroke: t[1], radius: 'radius/control' }, kids);
    if (!loading) { c.children[0].name = 'icon-leading'; c.children[2].name = 'icon-trailing'; }
    touchMode(c);
  });
  if (p.State === 'Focus') focusRing(c);
}

async function buildActions(page) {
  const root = pageShell(page, 'Actions', 'Buttons and icon buttons. One primary action per area; secondary for everything else; destructive actions ask for confirmation (…).');
  const button = makeSet('Button', BUTTON_AXES, buttonVariant, BUTTON_OPTS);
  componentBlock(root, button, { title: 'Button', summary: 'Height 32 (Sm), 36 (Md) or 48 (Touch). Label in sentence case, verb first. Link and Loading arrived in 1.7.0.',
    use: ['Primary for the main action of a page or card (Accept, Start reviewing).', 'Secondary for supporting actions (Export, View shop).', 'Destructive for Reject…, Suspend… — always followed by a confirmation.', 'Link for text actions under a form (Forgot password?, Back to sign in).', 'Loading while a submit is in flight; the form is read-only, no page spinner.', 'Touch size on the tablet order board and on every Auth screen.'],
    props: ['Label (text)', 'Leading icon / Trailing icon (boolean)', 'Icon (instance swap)', 'Variant · Size · State'],
    a11y: ['Focus state uses the Focus/Ring effect.', 'Disabled buttons explain why nearby (e.g. "Complete the 2 remaining checks").', 'Loading keeps the label and sets aria-busy; the width does not change.', 'Icon-only actions use IconButton with an aria-label.'],
    dont: ['Two primary buttons side by side.', 'Colour-only meaning: destructive labels say what they do.', 'Link for the main action of a form.'] });

  const ICB = { Secondary: { Default: ['bg/surface', 'border/control'], Hover: ['bg/subtle', 'border/control'], Focus: ['bg/surface', 'border/control'], Disabled: ['bg/surface', 'border/default'] }, Ghost: { Default: [null, null], Hover: ['bg/subtle', null], Focus: [null, null], Disabled: [null, null] } };
  const iconBtn = makeSet('IconButton', { Variant: ['Secondary', 'Ghost'], Size: ['Sm', 'Md', 'Touch'], State: ['Default', 'Hover', 'Focus', 'Disabled'] }, function (c, p) {
    const t = ICB[p.Variant][p.State]; const z = BTN_SIZE[p.Size];
    withTouch(z[3], function () {
      body(c, { dir: 'H', w: z[0], h: z[0], align: 'center', justify: 'center', fill: t[0], stroke: t[1], radius: 'radius/control' }, [icon('more-vertical', p.State === 'Disabled' ? 'icon/muted' : 'icon/default', 18)]);
      c.children[0].name = 'icon'; touchMode(c);
    });
    if (p.State === 'Focus') focusRing(c);
  }, { width: 1180, desc: 'Square icon-only button. Always give it an accessible name in code.', swap: [{ prop: 'Icon', node: 'icon', def: 'more-vertical' }] });
  componentBlock(root, iconBtn, { title: 'IconButton', summary: 'Row actions (more), zoom, sort, sound on the board.', use: ['Row actions menu, pagination arrows, zoom in and out.'], props: ['Icon (instance swap)', 'Variant · Size · State'], a11y: ['aria-label is required: "Actions for MP-10482".'] });
  tag(root);
}

// Input (release 1.7.0 adds the Type axis: Text, Password, Code). Top level, so "Update library" can add the new variants.
const INPUT_AXES = { Type: ['Text', 'Password', 'Code'], State: ['Default', 'Hover', 'Focus', 'Filled', 'Disabled', 'Error'] };
// SegmentedControl text before 1.9.0, and the radio-group use 1.9.0 adds (sellers ux.md 10: Yes/No and All/Only-selected).
const SEG_DESC_170 = 'Period switcher. First segment selected.';
const SEG_DESC = SEG_DESC_170 + ' Also a question with two or three answers (1.9.0), such as Yes or No: hide segment 3 for two answers; in code it is a radio group.';
const SEG_A11Y_170 = ['role="group" with aria-pressed on each segment.'];
const SEG_A11Y = ['As a period switcher: role="group" with aria-pressed on each segment.', 'As a question (Yes or No, All types or Only selected types): role="radiogroup" named by the question, role="radio" with aria-checked on each segment; arrow keys move the choice and Tab leaves the group.'];
const INPUT_DESC_170 = 'Text and search input. Border uses border/input (3:1). Type=Password (1.7.0) adds a show/hide IconButton (exposed as "reveal"; icon eye while the password is hidden, swap it to eye-off while it shows; aria-pressed in code). Type=Code (1.7.0) is one field in the mono text style for a 6-digit code or a backup code: inputmode numeric, autocomplete one-time-code, no auto-advance or auto-submit. Password and Code keep their own text per state, because a TEXT property would force one text on every variant; Value applies to Type=Text.';
// 1.9.0 "Seller setup" (sellers ux.md section 4): a fixed prefix before the value, Type=Text only. The shop web address shows the storefront
// address before the slug; an amount shows the Market's ISO currency code (AUD, never a bare "$"). Left to right, muted, on the logical start side.
const INPUT_PREFIX = 'mondapac.com.au/shop/';
const INPUT_OPTS = { width: 1040, colAxis: 'Type', desc: INPUT_DESC_170 + ' Show prefix and Prefix (1.9.0, Type=Text) put fixed text before the value: the storefront address before a shop web address, or the Market\'s ISO currency code before an amount (never a bare "$"). The prefix is dir="ltr", muted, on the start side, and part of the accessible name through the label or help, not announced twice.',
  text: [{ prop: 'Value', node: 'value', def: 'Order number or product' }, { prop: 'Prefix', node: 'prefix', def: INPUT_PREFIX }], bool: [{ prop: 'Leading icon', node: 'icon-leading', def: true }, { prop: 'Show prefix', node: 'prefix', def: false }] };
const INPUT_DOC = { title: 'Input', summary: 'Search, filters and form fields. Wrap it in Field for a label, helper and error.', use: ['Search inside index pages; filters; form fields inside Field.', 'Type=Password for every password; Type=Code for a one-time code or backup code.', 'Show prefix (1.9.0) for a shop web address (storefront address before the slug) or an amount (ISO currency code); turn Leading icon off with it.'], props: ['Value (text, Type=Text)', 'Leading icon (boolean)', 'Show prefix (boolean) and Prefix (text), Type=Text', 'Type · State'], a11y: ['Always paired with a visible or visually hidden label (Field).', 'Error state adds a message below; colour is not enough.', 'The show/hide button is named "Show password" or "Hide password" and sits after its field in the focus order.'] };
const INPUT_ICON = { Text: 'search', Password: 'lock', Code: 'key' };
function inputPrefix() { const t = text(INPUT_PREFIX, 'Body/Default', 'text/muted', { name: 'prefix' }); t.visible = false; return t; }
function inputVariant(c, p) {
  const type = p.Type || 'Text';
  const border = p.State === 'Error' ? 'status/critical/solid' : (p.State === 'Focus' ? 'action/primary' : (p.State === 'Hover' ? 'text/muted' : 'border/input'));
  const filled = p.State === 'Filled' || (type !== 'Text' && p.State === 'Focus');
  let value;
  if (type === 'Text') value = text(p.State === 'Filled' ? 'MP-10482' : 'Order number or product', 'Body/Default', p.State === 'Filled' ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL', truncate: true });
  else if (type === 'Password') value = text(filled ? '••••••••••••••••' : '', 'Body/Default', p.State === 'Disabled' ? 'text/muted' : 'text/primary', { name: 'secret', sizeH: 'FILL', truncate: true });
  else value = text(filled ? '482913' : '', 'Mono/Default', p.State === 'Disabled' ? 'text/muted' : 'text/primary', { name: 'code', sizeH: 'FILL', truncate: true });
  const kids = [icon(INPUT_ICON[type], 'icon/muted', 16)];
  if (type === 'Text') kids.push(inputPrefix());
  kids.push(value);
  if (type === 'Password') kids.push(inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: p.State === 'Disabled' ? 'Disabled' : 'Default', Icon: { icon: 'eye' } }, { name: 'reveal' }));
  body(c, { dir: 'H', w: 280, h: 'size/control', pad: [0, type === 'Password' ? 'space/0-5' : 'space/2-5', 0, 'space/2-5'], gap: 'space/2', align: 'center', fill: p.State === 'Disabled' ? 'bg/muted' : 'bg/surface', stroke: border, radius: 'radius/control' }, kids);
  c.children[0].name = 'icon-leading';
  if (type === 'Password') safe('expose reveal', function () { c.children[2].isExposedInstance = true; });
  if (p.State === 'Focus') focusRing(c);
}

async function buildForms(page) {
  const root = pageShell(page, 'Forms & selection', 'Inputs, checkboxes, switches, segmented controls, tabs and filter chips.');
  const input = makeSet('Input', INPUT_AXES, inputVariant, INPUT_OPTS);
  componentBlock(root, input, INPUT_DOC);
  fieldStatusBlock(root); // 1.9.0: Field holds a FieldStatus line
  fieldBlock(root);
  selectBlock(root);
  textareaBlock(root);
  formActionBarBlock(root); // 1.9.0

  const cb = makeSet('Checkbox', { Value: ['Unchecked', 'Checked', 'Indeterminate'], State: ['Default', 'Focus', 'Disabled'] }, function (c, p) {
    const on = p.Value !== 'Unchecked';
    body(c, { dir: 'H', w: 16, h: 16, align: 'center', justify: 'center', fill: on ? (p.State === 'Disabled' ? 'action/primary-disabled' : 'action/primary') : (p.State === 'Disabled' ? 'bg/muted' : 'bg/surface'), stroke: on ? null : 'border/input', radius: 4 }, [
      p.Value === 'Checked' ? icon('check', 'text/on-accent', 12) : (p.Value === 'Indeterminate' ? icon('minus', 'text/on-accent', 12) : null),
    ]);
    if (p.State === 'Focus') focusRing(c);
  }, { width: 520, desc: 'Row selection and checks.' });
  componentBlock(root, cb, { title: 'Checkbox', summary: '16 px box with a 24 px hit area in code.', a11y: ['Header checkbox uses Indeterminate when some rows are selected.', 'Label each row checkbox: "Select MP-10482".'] });
  checkboxRowBlock(root);

  const sw = makeSet('Switch', { On: ['True', 'False'], Size: ['Md', 'Touch'] }, function (c, p) {
    const W = p.Size === 'Touch' ? 40 : 32, H = p.Size === 'Touch' ? 24 : 18, K = H - 4;
    c.layoutMode = 'NONE'; c.resize(W, H); c.cornerRadius = H / 2;
    c.fills = [paint(p.On === 'True' ? 'status/success/fg' : 'border/control')];
    const k = ellipse({ name: 'knob', w: K, fill: 'bg/surface', xy: [p.On === 'True' ? W - K - 2 : 2, 2] }); add(c, k);
  }, { width: 520, desc: 'On/off setting that applies immediately, e.g. Taking instant orders.' });
  componentBlock(root, sw, { title: 'Switch', summary: 'Immediate on/off settings.', a11y: ['role="switch" with aria-checked.', 'Turning off instant orders asks for confirmation.'] });

  const seg = makeComponent('SegmentedControl', function (c) {
    body(c, { dir: 'H', h: 'size/control', stroke: 'border/control', radius: 'radius/control', fill: 'bg/surface', clip: true }, [
      frame({ name: 'segment-1', dir: 'H', px: 'space/3', align: 'center', fill: 'bg/selected', sizeV: 'FILL' }, [text('Today', 'Body/Strong', 'text/link', { name: 'label-1' })]),
      frame({ name: 'segment-2', dir: 'H', px: 'space/3', align: 'center', stroke: 'border/control', sides: ['left'], sizeV: 'FILL' }, [text('7 days', 'Body/Default', 'text/secondary', { name: 'label-2' })]),
      frame({ name: 'segment-3', dir: 'H', px: 'space/3', align: 'center', stroke: 'border/control', sides: ['left'], sizeV: 'FILL' }, [text('30 days', 'Body/Default', 'text/secondary', { name: 'label-3' })]),
    ]);
  }, { desc: SEG_DESC, text: [{ prop: 'Segment 1', node: 'label-1', def: 'Today' }, { prop: 'Segment 2', node: 'label-2', def: '7 days' }, { prop: 'Segment 3', node: 'label-3', def: '30 days' }] });
  const segWrap = frame({ name: 'SegmentedControl', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(segWrap, seg);
  componentBlock(root, segWrap, { title: 'SegmentedControl', summary: 'Switch the period of a dashboard.', a11y: SEG_A11Y });
  settingRowBlock(root); // 1.10.0

  const tab = makeSet('Tab', { Selected: ['True', 'False'] }, function (c, p) {
    const on = p.Selected === 'True';
    body(c, { dir: 'H', h: 40, px: 'space/2-5', gap: 'space/1-5', align: 'center', stroke: on ? 'action/primary' : null, sides: ['bottom'], strokeW: 2 }, [
      text('All', on ? 'Body/Strong' : 'Body/Medium', on ? 'text/link' : 'text/secondary', { name: 'label' }), text('128', 'Body/Default', 'text/muted', { name: 'count' }),
    ]);
  }, { width: 520, desc: 'Saved view tab with count.', text: [{ prop: 'Label', node: 'label', def: 'All' }, { prop: 'Count', node: 'count', def: '128' }], bool: [{ prop: 'Show count', node: 'count', def: true }] });
  componentBlock(root, tab, { title: 'Tab', summary: 'Saved views on index pages. Counts are live.', a11y: ['role="tab" with aria-selected; the bar is role="tablist".'] });

  const chip = makeSet('FilterChip', { Type: ['Applied', 'Add'] }, function (c, p) {
    if (p.Type === 'Applied') {
      body(c, { dir: 'H', h: 30, pad: [0, 6, 0, 10], gap: 'space/1-5', align: 'center', fill: 'bg/selected', radius: 'radius/pill' }, [text('Placed: Today', 'Body/Small Strong', 'text/link', { name: 'label' }), icon('x', 'text/link', 14)]);
    } else {
      body(c, { dir: 'H', h: 30, px: 'space/2-5', gap: 'space/1-5', align: 'center', stroke: 'border/input', dash: [3, 3], radius: 'radius/pill' }, [text('+ Add filter', 'Body/Small', 'text/secondary', { name: 'add-label' })]);
    }
  }, { width: 520, desc: 'Applied filter (removable) and the add-filter trigger.', text: [{ prop: 'Label', node: 'label', def: 'Placed: Today' }] });
  componentBlock(root, chip, { title: 'FilterChip', summary: 'Applied filters sit next to search. Removing one updates results at once.', a11y: ['The × button is labelled "Remove filter Placed".'] });
  fieldPreferred();
  tag(root);
}

async function buildStatus(page) {
  const root = pageShell(page, 'Status & feedback', 'Badges, status, certificates, health, deadlines, meters and banners. State is always a word plus a shape, never colour alone.');
  const BICON = { Success: 'check', Info: 'clock', Attention: 'clock', Critical: 'alert-circle', Neutral: 'circle' };
  const badge = makeSet('Badge', { Tone: ['Success', 'Info', 'Attention', 'Critical', 'Neutral'], Leading: ['Dot', 'Icon', 'None'] }, function (c, p) {
    const t = TONE[p.Tone];
    body(c, { dir: 'H', h: 'size/badge', px: 'space/2', gap: 'space/1-5', align: 'center', fill: t[0], radius: 'radius/pill' }, [
      p.Leading === 'Dot' ? dot(t[1]) : (p.Leading === 'Icon' ? icon(BICON[p.Tone], t[1], 12) : null), text(p.Tone === 'Critical' ? 'Overdue 4 h' : (p.Tone === 'Attention' ? 'Due 5:00 pm' : (p.Tone === 'Success' ? 'Active' : (p.Tone === 'Info' ? 'Scheduled' : 'Due 2 Oct'))), 'Caption/Strong', t[1], { name: 'label' }),
    ]);
    if (p.Leading === 'Icon') c.children[0].name = 'icon';
  }, { width: 1040, desc: 'Short status or deadline label.', text: [{ prop: 'Label', node: 'label', def: 'Active' }], swap: [{ prop: 'Icon', node: 'icon', def: 'check' }] });
  componentBlock(root, badge, { title: 'Badge', summary: 'Pill, 22 px. Tone carries meaning; the dot or icon repeats it for colour-blind users.', use: ['Success: active, healthy, paid.', 'Info: scheduled, in review.', 'Attention: due today, waiting.', 'Critical: overdue, suspended.', 'Neutral: future dates, counts.'] });

  const ST = [['Needs action', 'Attention', 0], ['Preparing', 'Info', 50], ['Ready for pickup', 'Info', 75], ['Out for delivery', 'Info', 88], ['Delivered', 'Success', 100], ['Cancelled', 'Critical', -1], ['Scheduled', 'Neutral', 0], ['In review', 'Info', 50]];
  const sb = makeSet('StatusBadge', { Status: ST.map(function (s) { return s[0]; }) }, function (c, p) {
    const s = ST.filter(function (x) { return x[0] === p.Status; })[0]; const t = TONE[s[1]];
    body(c, { dir: 'H', h: 'size/badge', pad: [0, 8, 0, 7], gap: 'space/1-5', align: 'center', fill: t[0], radius: 'radius/pill' }, [
      s[2] < 0 ? rect({ name: 'stop', w: 10, h: 10, fill: t[1], radius: 2 }) : progressRing(t[1], s[2]), text(s[0], 'Caption/Strong', t[1], { name: 'label' }),
    ]);
  }, { width: 1040, desc: 'Order and review status with a progress ring: empty = waiting, half = in progress, full = done.' });
  componentBlock(root, sb, { title: 'StatusBadge', summary: 'The ring shows how far along the flow the item is.', a11y: ['The ring is decorative; the word is the status.'] });

  const cnt = makeSet('CountBadge', { Tone: ['Attention', 'Neutral', 'Info', 'Critical'] }, function (c, p) {
    const t = TONE[p.Tone];
    body(c, { dir: 'H', h: 20, px: 'space/2', align: 'center', justify: 'center', fill: p.Tone === 'Critical' ? 'status/critical/meter' : t[0], radius: 'radius/pill' }, [text('3', 'Caption/Strong', p.Tone === 'Critical' ? 'text/on-accent' : t[1], { name: 'count' })]);
  }, { width: 520, desc: 'Counts in navigation and notifications.', text: [{ prop: 'Count', node: 'count', def: '3' }] });
  componentBlock(root, cnt, { title: 'CountBadge', summary: 'Attention for work waiting on you, Neutral for plain counts, Critical for unread alerts.' });

  const CK = { Seller: ['cert/seller', 'badge-check', 'Halal', false], Manufacturer: ['cert/manufacturer', 'briefcase', 'Halal · manufacturer', false], Vegan: ['cert/vegan', 'leaf', 'Vegan', false], 'Self-declared': ['cert/vegan', 'leaf', 'Vegan · self-declared', true], Revoked: ['status/critical', null, 'Halal', false] };
  const cert = makeSet('CertChip', { Kind: Object.keys(CK) }, function (c, p) {
    const k = CK[p.Kind]; const rev = p.Kind === 'Revoked';
    const fg = rev ? 'status/critical/fg' : k[0] + '/fg';
    body(c, { dir: 'H', h: 24, px: 'space/2', gap: 'space/1-5', align: 'center', fill: rev ? 'status/critical/bg' : k[0] + '/bg', stroke: rev ? 'status/critical/border' : (k[3] ? 'cert/vegan/self-declared-border' : k[0] + '/border'), dash: k[3] ? [3, 3] : null, radius: 'radius/chip' }, [
      k[1] ? icon(k[1], fg, 13) : null, text(k[2], 'Caption/Strong', fg, { name: 'scheme', strike: rev }), text(rev ? 'Revoked' : '· exp 15 Oct', 'Caption/Strong', rev ? 'status/critical/fg' : 'status/attention/fg', { name: rev ? 'revoked' : 'note' }),
    ]);
  }, { width: 1040, desc: 'Certificate kind (CERT-24/44). Seller and manufacturer certificates are verified; self-declared is dashed.', text: [{ prop: 'Note', node: 'note', def: '· exp 15 Oct' }], bool: [{ prop: 'Show note', node: 'note', def: false }] });
  componentBlock(root, cert, { title: 'CertChip', summary: 'Show who stands behind the claim: the seller, the manufacturer, or nobody (self-declared).', use: ['Show the expiry note when 14 days or fewer remain.'], a11y: ['The kind is in the text, not only in the border style.'] });

  const HL = { Healthy: ['status/success/fg', 'check'], 'At risk': ['status/attention/fg', 'alert-triangle'], Unhealthy: ['status/critical/fg', 'alert-circle'], 'No data': ['text/muted', null] };
  const health = makeSet('HealthIndicator', { State: Object.keys(HL) }, function (c, p) {
    const h = HL[p.State];
    body(c, { dir: 'H', gap: 'space/1-5', align: 'center' }, [h[1] ? icon(h[1], h[0], 14) : null, text(p.State, p.State === 'No data' ? 'Body/Default' : 'Body/Strong', h[0], { name: 'label' })]);
  }, { width: 520, desc: 'Seller account health against targets.' });
  componentBlock(root, health, { title: 'HealthIndicator', summary: 'Icon + word. Used in seller tables and seller summaries.' });

  const MT = { Accent: ['chart/meter-track', 'action/primary'], Attention: ['status/attention/track', 'status/attention/solid'], Critical: ['status/critical/track', 'status/critical/meter'], Success: ['status/success/track', 'status/success/fg'] };
  const meter = makeSet('Meter', { Tone: Object.keys(MT), Value: ['0', '25', '50', '75', '100'] }, function (c, p) {
    const m = MT[p.Tone]; c.layoutMode = 'NONE'; c.resize(120, 6); c.fills = [];
    const tr = rect({ name: 'track', w: 120, h: 6, fill: m[0], radius: 3, xy: [0, 0] }); add(c, tr); tr.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    const v = parseInt(p.Value, 10);
    if (v > 0) { const fl = rect({ name: 'fill', w: Math.max(2, 1.2 * v), h: 6, fill: m[1], radius: 3, xy: [0, 0] }); add(c, fl); fl.constraints = { horizontal: 'SCALE', vertical: 'STRETCH' }; }
  }, { width: 1040, gapX: 40, desc: 'Share of time or capacity used. Accent < 75 %, Attention 75–99 %, Critical ≥ 100 %.' });
  componentBlock(root, meter, { title: 'Meter', summary: 'Resize the instance freely; the fill scales.', a11y: ['role="meter" with aria-valuenow and a label.'] });

  const DL = { Overdue: ['Critical', 'Overdue 4 h', 'Critical', '100'], 'Due soon': ['Attention', 'Due 5:00 pm', 'Accent', '75'], Upcoming: ['Neutral', 'Due 2 Oct', 'Accent', '25'] };
  const dl = makeSet('DeadlineBadge', { Tone: Object.keys(DL) }, function (c, p) {
    const d = DL[p.Tone];
    body(c, { dir: 'V', gap: 'space/1-5' }, [inst('Badge', { Tone: d[0], Leading: 'None', Label: d[1] }, { name: 'badge' }), inst('Meter', { Tone: d[2], Value: d[3] }, { name: 'meter' })]);
  }, { width: 520, desc: 'Deadline text plus the share of the review time already used.', bool: [{ prop: 'Show meter', node: 'meter', def: true }] });
  componentBlock(root, dl, { title: 'DeadlineBadge', summary: 'Rules (pending PO, D15): overdue = critical, under 24 h = attention, later = neutral.' });

  const IB = { Info: ['bg/info-banner', 'border/info', 'text/link', 'badge-check'], Attention: ['status/attention/surface', 'status/attention/border', 'status/attention/fg', 'clock'], Critical: ['status/critical/bg', 'status/critical/border', 'status/critical/fg', 'alert-circle'], Success: ['status/success/bg', 'status/success/track', 'status/success/fg', 'check'] };
  const banner = makeSet('InfoBanner', { Tone: Object.keys(IB) }, function (c, p) {
    const b = IB[p.Tone];
    body(c, { dir: 'H', w: 960, pad: [14, 16, 14, 16], gap: 'space/3', align: 'start', fill: b[0], stroke: b[1], radius: 'radius/card' }, [
      icon(b[3], b[2], 20),
      frame({ name: 'content', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Your Halal certificate renewal is in review', 'Body/Strong', 'text/primary', { name: 'title', sizeH: 'FILL' }), text('Your current certificate stays valid until 15 Oct 2026, so your 38 Halal offers are not affected.', 'Body/Default', 'text/secondary', { name: 'body', sizeH: 'FILL' })]),
      text('View certificate', 'Body/Strong', 'text/link', { name: 'action' }),
    ]);
  }, { width: 1040, desc: 'Page-level message. One per page at most.', text: [{ prop: 'Title', node: 'title', def: 'Your Halal certificate renewal is in review' }, { prop: 'Body', node: 'body', def: 'Your current certificate stays valid until 15 Oct 2026, so your 38 Halal offers are not affected.' }, { prop: 'Action', node: 'action', def: 'View certificate' }], bool: [{ prop: 'Show action', node: 'action', def: true }] });
  componentBlock(root, banner, { title: 'InfoBanner', summary: 'Explain what is happening and what (if anything) the user needs to do.', a11y: ['role="status" for information, role="alert" only for critical.'] });

  const tip = makeComponent('Tooltip', function (c) {
    body(c, { dir: 'V', pad: [8, 10, 8, 10], gap: 'space/0-5', fill: 'chart/tooltip-bg', radius: 'radius/control' }, [text('Today, 2:30 pm', 'Caption/Default', 'chart/tooltip-muted', { name: 'label' }), text('AUD 12,904.60', 'Body/Strong', 'chart/tooltip-fg', { name: 'value' })]);
  }, { desc: 'Chart and map tooltip (inverse surface).', text: [{ prop: 'Label', node: 'label', def: 'Today, 2:30 pm' }, { prop: 'Value', node: 'value', def: 'AUD 12,904.60' }] });
  const tipWrap = frame({ name: 'Tooltip', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(tipWrap, tip);
  componentBlock(root, tipWrap, { title: 'Tooltip', summary: 'Inverse surface so it reads above any chart.' });
  toastBlock(root);
  dialogBlock(root);
  tag(root);
}

// ==== 31_components.js ====
// ---------------------------------------------------------------- data display
const IDT = { Teal: ['cert/seller/tile', 'cert/seller/fg'], Amber: ['status/attention/bg', 'status/attention/fg'], Blue: ['bg/selected', 'text/link'], Purple: ['tile/purple-bg', 'tile/purple-fg'], Red: ['status/critical/bg', 'status/critical/fg'], Neutral: ['status/neutral/bg', 'status/neutral/fg'] };
function ring(o) {
  // o: { size, inner, pct, track, fill }
  const f = frame({ name: o.name || 'ring', w: o.size, h: o.size }); f.fills = [];
  const t = ellipse({ name: 'track', w: o.size, fill: o.track, xy: [0, 0] }); t.arcData = { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: o.inner }; add(f, t);
  if (o.pct > 0) { const a = ellipse({ name: 'value', w: o.size, fill: o.fill, xy: [0, 0] }); a.arcData = { startingAngle: -Math.PI / 2, endingAngle: -Math.PI / 2 + Math.PI * 2 * Math.min(o.pct, 0.999), innerRadius: o.inner }; add(f, a); }
  return f;
}
function centered(node, size) {
  const c = frame({ name: 'center', dir: 'V', align: 'center', justify: 'center', w: size, h: size }); c.fills = [];
  add(c, node); return c;
}

async function buildDataDisplay(page) {
  const root = pageShell(page, 'Data display', 'Stat tiles, sparklines, charts, rings and identity. One axis per chart, legend for two or more series, values in text tokens, never in the series colour.');
  const tile = makeSet('IdentityTile', { Tone: Object.keys(IDT), Shape: ['Rounded', 'Circle'] }, function (c, p) {
    const t = IDT[p.Tone];
    body(c, { dir: 'H', w: 32, h: 32, align: 'center', justify: 'center', fill: t[0], radius: p.Shape === 'Circle' ? 'radius/pill' : 'radius/control' }, [text('KF', 'Caption/Strong', t[1], { name: 'initials' })]);
  }, { width: 760, desc: 'Seller logo placeholder, avatar, queue item type.', text: [{ prop: 'Initials', node: 'initials', def: 'KF' }] });
  componentBlock(root, tile, { title: 'IdentityTile', summary: 'Rounded for shops and item types, circle for people.' });

  const TH = { Meat: 'meat', Poultry: 'poultry', Bakery: 'bakery', Pantry: 'pantry', Other: 'other' };
  const thumb = makeSet('ProductThumb', { Category: Object.keys(TH), Size: ['Sm', 'Md'] }, function (c, p) {
    const s = p.Size === 'Sm' ? 28 : 34; const k = TH[p.Category];
    body(c, { dir: 'H', w: s, h: s, align: 'center', justify: 'center', fill: 'thumb/' + k + '-bg', radius: Math.round(s / 4) }, [icon('product-' + k, 'thumb/' + k + '-fg', p.Size === 'Sm' ? 18 : 20)]);
  }, { width: 760, desc: 'Product category glyph. Replace with the product photo when available (same size and radius).' });
  componentBlock(root, thumb, { title: 'ProductThumb', summary: 'Stack up to three with an 8 px overlap and a 2 px surface ring; show +n for more.' });

  const sparkVals = [150, 158, 149, 162, 170, 166, 172, 169, 175, 171, 178, 184];
  const spark = makeSet('Sparkline', { Tone: ['Accent', 'Attention'] }, function (c, p) {
    const sp = sparkline(sparkVals, 84, 30, p.Tone === 'Accent' ? 'chart/series-1' : 'status/attention/solid');
    c.layoutMode = 'NONE'; c.resize(84, 30); c.fills = [];
    sp.children.slice().forEach(function (n) { add(c, n); });
    sp.remove();
  }, { width: 520, desc: '12-point trend, no axis. End dot marks the current value.' });
  componentBlock(root, spark, { title: 'Sparkline', summary: 'Shape only; the stat tile carries the numbers.' });

  const stat = makeSet('StatTile', { Trend: ['Sparkline', 'Meter', 'None'], Tone: ['Positive', 'Neutral'] }, function (c, p) {
    body(c, { dir: 'V', w: 280, pad: [16, 18, 16, 18], gap: 'space/1-5' }, [
      text('Orders today', 'Body/Small Strong', 'text/secondary', { name: 'label' }),
      frame({ name: 'value-row', dir: 'H', align: 'end', justify: 'between', sizeH: 'FILL' }, [
        text('184', 'Heading/Stat', 'text/primary', { name: 'value' }),
        p.Trend === 'Sparkline' ? inst('Sparkline', { Tone: 'Accent' }, { name: 'trend' }) : null,
      ]),
      p.Trend === 'Meter' ? inst('Meter', { Tone: 'Accent', Value: '25' }, { name: 'meter', sizeH: 'FILL' }) : null,
      text(p.Tone === 'Positive' ? '↑ 12 vs yesterday' : 'Target 95%', p.Tone === 'Positive' ? 'Body/Small Strong' : 'Body/Small', p.Tone === 'Positive' ? 'status/success/fg' : 'text/muted', { name: 'delta' }),
    ]);
  }, { width: 1040, desc: 'Label, value, delta against a named period, optional trend or meter. Tone=Positive colours the delta green; use it only when up is good.', text: [{ prop: 'Label', node: 'label', def: 'Orders today' }, { prop: 'Value', node: 'value', def: '184' }, { prop: 'Delta', node: 'delta', def: '↑ 12 vs yesterday' }] });
  componentBlock(root, stat, { title: 'StatTile', summary: 'Always say what the delta compares against.', use: ['Line them up in a KPI strip with 1 px dividers.', 'Positive delta uses the success colour only when up is good.'] });

  // Trend chart (static reference drawing; code renders live data)
  const chart = makeComponent('TrendChart', function (c) {
    const W = 760, H = 200, padTop = 14, max = 32000;
    const yHourly = [12, 8, 5, 3, 4, 10, 60, 240, 520, 780, 950, 1180, 1420, 1260, 1050, 980, 1150, 1620, 1980, 1890, 1430, 900, 450, 180];
    const k = 11926.58 / 6977; const yest = yHourly.map(function (v) { return v * k; });
    const noise = [1.1, 0.9, 1.2, 1, 0.8, 1.1, 1.05, 1.12, 1.04, 1.09, 1.1, 1.06, 1.11, 1.07, 1.1];
    const X = function (h) { return h / 24 * W; }; const Y = function (v) { return H - v / max * (H - padTop); };
    const cum = function (arr, upto) { const pts = [[0, 0]]; let s = 0; for (let h = 0; h < 24; h++) { if (h + 1 > upto) { s += arr[h] * (upto - h); pts.push([upto, s]); break; } s += arr[h]; pts.push([h + 1, s]); } return pts; };
    const yPts = cum(yest, 24); const raw = cum(yest.map(function (v, i) { return v * (noise[i] || 1); }), 14.5);
    const sc = 12904.6 / raw[raw.length - 1][1]; const tPts = raw.map(function (p) { return [p[0], p[1] * sc]; });
    const path = function (pts) { return 'M ' + pts.map(function (p) { return X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' L '); };
    const last = tPts[tPts.length - 1]; const mx = X(last[0]), my = Y(last[1]);
    body(c, { dir: 'V', gap: 'space/2', w: W }, [
      frame({ name: 'legend', dir: 'H', gap: 'space/4', align: 'center' }, [
        frame({ name: 'today', dir: 'H', gap: 'space/1-5', align: 'center' }, [rect({ name: 'key', w: 14, h: 2, fill: 'chart/series-1' }), text('Today', 'Body/Small', 'text/secondary')]),
        frame({ name: 'yesterday', dir: 'H', gap: 'space/1-5', align: 'center' }, [vector({ name: 'key', d: 'M 0 0 L 14 0', stroke: 'chart/compare', strokeW: 2, dash: [3, 3] }), text('Yesterday', 'Body/Small', 'text/secondary')]),
      ]),
    ]);
    const plot = frame({ name: 'plot', w: W, h: 232 }); plot.fills = [];
    [10000, 20000, 30000].forEach(function (v) { add(plot, rect({ name: 'grid ' + v, w: W, h: 1, fill: 'chart/grid', xy: [0, Y(v)] })); add(plot, text({ 10000: '10,000', 20000: '20,000', 30000: '30,000' }[v], 'Caption/Default', 'text/muted', { xy: [0, Y(v) - 17] })); });
    add(plot, rect({ name: 'baseline', w: W, h: 1, fill: 'chart/axis', xy: [0, H] }));
    add(plot, vector({ name: 'yesterday', d: path(yPts), stroke: 'chart/compare', strokeW: 2, dash: [5, 5], xy: [0, 0] }));
    add(plot, vector({ name: 'area', d: path(tPts) + ' L ' + mx.toFixed(1) + ' ' + H + ' L 0 ' + H + ' Z', fill: 'chart/series-1', fillOpacity: 0.1, closed: true, xy: [0, 0] }));
    add(plot, vector({ name: 'today', d: path(tPts), stroke: 'chart/series-1', strokeW: 2, xy: [0, 0] }));
    add(plot, rect({ name: 'crosshair', w: 1, h: H - 14, fill: 'chart/series-1', fillOpacity: 0.35, xy: [mx, 14] }));
    add(plot, ellipse({ name: 'marker', w: 10, fill: 'chart/series-1', stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [mx - 5, my - 5] }));
    add(plot, inst('Tooltip', {}, { xy: [mx - 160, my - 66] }));
    ['12 am', '6 am', '12 pm', '6 pm', '12 am'].forEach(function (l, i) { add(plot, text(l, 'Caption/Default', 'text/muted', { xy: [i === 0 ? 0 : (i === 4 ? W - 34 : i * 190 - 16), 210] })); });
    add(c, plot);
  }, { desc: 'Cumulative trend with a dashed comparison period, crosshair and tooltip. Reference drawing: code renders live data with the same tokens.' });
  const chartWrap = frame({ name: 'TrendChart', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(chartWrap, chart);
  componentBlock(root, chartWrap, { title: 'TrendChart', summary: 'One y-axis. Legend always present for two series. Hover shows a crosshair and tooltip.', a11y: ['Provide a summary label and a "View as table" option.'], dont: ['Second y-axis.', 'Values written in the series colour.'] });

  const donut = makeComponent('DonutProgress', function (c) {
    c.layoutMode = 'NONE'; c.resize(72, 72); c.fills = [];
    add(c, ring({ size: 72, inner: 0.78, pct: 0.84, track: 'chart/donut-track', fill: 'cert/seller/fg' }));
    const lbl = centered(text('84%', 'Body/Strong', 'text/primary', { name: 'value' }), 72); lbl.x = 0; lbl.y = 0; add(c, lbl);
  }, { desc: 'Share of a whole, e.g. sellers with a valid certificate.', text: [{ prop: 'Value', node: 'value', def: '84%' }] });
  const split = makeComponent('SplitBar', function (c) {
    body(c, { dir: 'H', w: 300, h: 10, gap: 2 }, [rect({ name: 'part-1', w: 254, h: 10, fill: 'chart/series-1', radius: 0, sizeH: 'FILL' }), rect({ name: 'part-2', w: 44, h: 10, fill: 'chart/split-2' })]);
    c.children[0].topLeftRadius = 4; c.children[0].bottomLeftRadius = 4; c.children[1].topRightRadius = 4; c.children[1].bottomRightRadius = 4;
  }, { desc: 'Two-part split with a 2 px gap, legend below in code.' });
  const weekly = makeComponent('WeeklyBars', function (c) {
    c.layoutMode = 'NONE'; c.resize(304, 92); c.fills = [];
    add(c, rect({ name: 'baseline', w: 304, h: 1, fill: 'chart/axis', xy: [0, 70] }));
    const vals = [1890, 2104, 1975, 2260, 2410, 2318.4]; const lbls = ['1 Sep', '8 Sep', '15 Sep', '22 Sep', '29 Sep', '6 Oct'];
    vals.forEach(function (v, i) {
      const h = Math.round(v / 2500 * 52); const x = 14 + i * 50;
      const b = rect({ name: 'bar ' + lbls[i], w: 24, h: h, fill: i === 5 ? 'chart/series-1' : 'chart/series-1-soft', xy: [x, 70 - h] }); b.topLeftRadius = 4; b.topRightRadius = 4; add(c, b);
      add(c, text(lbls[i], 'Mono/Small', 'text/muted', { xy: [x - 4, 76] }));
    });
    add(c, text('2,318', 'Caption/Strong', 'text/primary', { xy: [264, 70 - Math.round(2318.4 / 2500 * 52) - 18] }));
  }, { desc: 'Columns ≤ 24 px, 4 px rounded top, square base; only the current value is labelled.' });
  const misc = frame({ name: 'Charts', dir: 'H', gap: 'space/8', pad: 32, fill: 'bg/surface', radius: 16, align: 'center' }, [donut, split, weekly]);
  componentBlock(root, misc, { title: 'DonutProgress · SplitBar · WeeklyBars', summary: 'Small charts for cards. Each has a text alternative in code.' });

  const CR = { Critical: ['status/critical/track', 'status/critical/solid', 'status/critical/fg', 0.69], Attention: ['status/attention/track', 'status/attention/solid', 'status/attention/fg', 0.55], Accent: ['chart/meter-track', 'action/primary', 'text/link', 0.48], Success: ['status/success/track', 'status/success/fg', 'status/success/fg', 0.42] };
  const cdr = makeSet('CountdownRing', { Tone: Object.keys(CR) }, function (c, p) {
    const t = CR[p.Tone];
    c.layoutMode = 'NONE'; c.resize(48, 48); c.fills = [];
    add(c, ring({ size: 48, inner: 0.82, pct: t[3], track: t[0], fill: t[1] }));
    const lbl = frame({ name: 'label', dir: 'V', align: 'center', justify: 'center', w: 48, h: 48 }); lbl.fills = [];
    add(lbl, text('18', 'Touch/Title', t[2], { name: 'minutes' })); add(lbl, text('min', 'Mono/Small', t[2], { name: 'unit' }));
    lbl.itemSpacing = -2; add(c, lbl); lbl.x = 0; lbl.y = 0;
  }, { width: 520, desc: 'Minutes left until ready-by or pickup. Updates every 60 s.', text: [{ prop: 'Minutes', node: 'minutes', def: '18' }] });
  componentBlock(root, cdr, { title: 'CountdownRing', summary: 'Rules (pending PO, D15): waiting ≥ 8 min → Critical; ≤ 20 min to ready → Attention; ready for courier → Success.', a11y: ['role="timer", not announced every minute.'] });
  tag(root);
}

// ---------------------------------------------------------------- tables & collections
async function buildTables(page) {
  const root = pageShell(page, 'Tables & collections', 'Index pages: header cells, cells by content type, pagination and the floating bulk action bar. Tables use real <table> markup in code.');
  const cell = makeSet('TableCell', { Type: ['Header', 'Text', 'Two-line', 'Number', 'Checkbox', 'Actions'], State: ['Default', 'Selected', 'Loading'] }, function (c, p) {
    const hdr = p.Type === 'Header';
    const fill = hdr ? 'bg/subtle' : (p.State === 'Selected' ? 'bg/row-selected' : 'bg/surface');
    const kids = [];
    if (p.State === 'Loading') tcSkeleton(p.Type).forEach(function (n) { kids.push(n); }); // 1.8.0: skeleton shapes in bg/muted instead of content
    else if (p.Type === 'Header') kids.push(text('Column', 'Body/Small Strong', 'text/muted', { name: 'label' }), icon('arrow-down', 'icon/muted', 12));
    else if (p.Type === 'Text') kids.push(text('Kuraby QLD 4112', 'Body/Default', 'text/primary', { name: 'label', truncate: true, sizeH: 'FILL' }));
    else if (p.Type === 'Two-line') kids.push(frame({ name: 'lines', dir: 'V', sizeH: 'FILL' }, [text('Kuraby Fresh', 'Body/Strong', 'text/primary', { name: 'label', truncate: true, sizeH: 'FILL' }), text('kuraby-fresh · Kuraby QLD 4112', 'Caption/Default', 'text/muted', { name: 'meta', truncate: true, sizeH: 'FILL' })]));
    else if (p.Type === 'Number') kids.push(text('AUD 86.40', 'Body/Default', 'text/primary', { name: 'label' }));
    else if (p.Type === 'Checkbox') kids.push(inst('Checkbox', { Value: p.State === 'Selected' ? 'Checked' : 'Unchecked', State: 'Default' }));
    else if (p.Type === 'Actions') kids.push(inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default' }));
    body(c, { dir: 'H', w: p.Type === 'Checkbox' || p.Type === 'Actions' ? 56 : 200, h: hdr ? 42 : 56, px: 'space/3', gap: 'space/1', align: 'center', justify: p.Type === 'Number' ? 'end' : (p.Type === 'Checkbox' || p.Type === 'Actions' ? 'center' : 'start'), fill: fill, stroke: hdr ? 'border/default' : 'border/row', sides: ['bottom'] }, kids);
    if (hdr) c.children[1].name = 'sort';
  }, { width: 1040, skip: function (p) { return p.Type === 'Header' && p.State !== 'Default'; }, desc: TABLECELL_DESC,
    text: [{ prop: 'Text', node: 'label', def: 'Kuraby Fresh' }, { prop: 'Meta', node: 'meta', def: 'kuraby-fresh · Kuraby QLD 4112' }], bool: [{ prop: 'Sorted', node: 'sort', def: false }] });
  componentBlock(root, cell, { title: 'TableCell', summary: 'Header 42 px, rows 56 px. Numbers right-aligned with tabular figures in code. State=Loading (1.8.0) shows skeleton shapes: build 8 skeleton rows while a list loads.', a11y: ['aria-sort on the sorted header.', 'Row checkbox labelled "Select <name>".', 'Loading: the table or list region has aria-busy="true", skeleton cells are aria-hidden, one visually hidden "Loading" text sits in a polite live region, and the header and tabs stay visible.'] });

  const card = makeComponent('CardHeader', function (c) {
    body(c, { dir: 'H', w: 560, pad: [16, 18, 12, 18], gap: 'space/3', align: 'center', justify: 'between' }, [text('Review queue', 'Heading/H2', 'text/primary', { name: 'title' }), text('Open full queue', 'Body/Small Strong', 'text/link', { name: 'action' })]);
  }, { desc: 'Title and optional link at the top of a card.', text: [{ prop: 'Title', node: 'title', def: 'Review queue' }, { prop: 'Action', node: 'action', def: 'Open full queue' }], bool: [{ prop: 'Show action', node: 'action', def: true }] });
  const pag = makeComponent('Pagination', function (c) {
    body(c, { dir: 'H', w: 960, pad: [12, 14, 12, 14], gap: 'space/2', align: 'center', justify: 'between' }, [
      text('1–25 of 128', 'Body/Small', 'text/muted', { name: 'range' }),
      frame({ name: 'controls', dir: 'H', gap: 'space/2', align: 'center' }, [text('Rows per page', 'Body/Small', 'text/muted'), inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: '25' }), inst('IconButton', { Variant: 'Secondary', Size: 'Sm', State: 'Disabled', Icon: { icon: 'chevron-left' } }), inst('IconButton', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Icon: { icon: 'chevron-right' } })]),
    ]);
  }, { desc: 'Range on the left, page size and arrows on the right.', text: [{ prop: 'Range', node: 'range', def: '1–25 of 128' }] });
  const bulk = makeComponent('BulkActionBar', function (c) {
    body(c, { dir: 'H', pad: [8, 8, 8, 16], gap: 'space/2', align: 'center', fill: 'bg/surface', stroke: 'border/control', radius: 'radius/card', effect: 'Elevation/Floating' }, [
      frame({ name: 'count', dir: 'H', gap: 'space/2', align: 'center' }, [inst('CountBadge', { Tone: 'Critical', Count: '2' }, { name: 'count-badge' }), text('selected', 'Body/Strong', 'text/link')]),
      rect({ name: 'divider', w: 1, h: 22, fill: 'border/default' }),
      inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Approve' }, { name: 'action-1' }), inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Message sellers' }, { name: 'action-2' }),
      inst('Button', { Variant: 'Destructive', Size: 'Sm', State: 'Default', Label: 'Suspend…' }, { name: 'action-3' }), inst('Button', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Label: 'Clear' }, { name: 'clear' }),
    ]);
    safe('expose count', function () { c.children[0].children[0].isExposedInstance = true; });
  }, { desc: 'Appears when one or more rows are selected; floats at the bottom of the content area.' });
  const tbl = frame({ name: 'Table parts', dir: 'V', gap: 'space/6', pad: 32, fill: 'bg/surface', radius: 16 }, [card, pag, bulk]);
  componentBlock(root, tbl, { title: 'CardHeader · Pagination · BulkActionBar', summary: 'The bulk bar is role="toolbar" and announces "2 selected" when it appears.' });
  emptyStateBlock(root);
  tag(root);
}

// ==== 32_components.js ====
// ---------------------------------------------------------------- navigation & shell
const NAV = {
  Admin: [['nav-home', 'Home', 'home'], ['nav-review', 'Review queue', 'inbox', ['Attention', '35']], ['g', 'Commerce'], ['nav-orders', 'Orders', 'clipboard', null, true], ['nav-catalogue', 'Catalogue', 'package', null, true],
    ['nav-sellers', 'Sellers', 'store', ['Neutral', '6']], ['nav-customers', 'Customers', 'users'], ['g', 'Money'], ['nav-finance', 'Finance', 'wallet', null, true], ['g', 'Platform'],
    ['nav-content', 'Content', 'file-text'], ['nav-settings', 'Settings', 'sliders'], ['nav-audit', 'Audit log', 'shield-check']],
  Seller: [['nav-home', 'Home', 'home'], ['nav-orders', 'Orders', 'clipboard', ['Attention', '3']], ['sub', 'Order board', 'nav-board'], ['sub', 'All orders', 'nav-all-orders'], ['nav-returns', 'Returns', 'undo'], ['g', 'Shop'],
    ['nav-catalogue', 'Catalogue', 'package', null, true], ['nav-certs', 'Certifications', 'badge-check', ['Attention', '1']], ['nav-messages', 'Messages', 'message', ['Neutral', '2']], ['g', 'Money'],
    ['nav-payouts', 'Payouts', 'wallet'], ['nav-settings', 'Settings', 'sliders']],
};
async function buildNavigation(page) {
  const root = pageShell(page, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.');
  const NI = { Default: [null, 'text/secondary', 'icon/default', 'Body/Medium'], Hover: ['bg/subtle', 'text/primary', 'icon/default', 'Body/Medium'], Active: ['bg/selected', 'text/link', 'text/link', 'Body/Strong'], Parent: [null, 'text/primary', 'icon/default', 'Body/Strong'] };
  const navItem = makeSet('NavItem', { State: Object.keys(NI), Collapsed: ['False', 'True'] }, function (c, p) {
    const t = NI[p.State];
    if (p.Collapsed === 'True') {
      body(c, { dir: 'H', w: 44, h: 36, align: 'center', justify: 'center', fill: t[0], radius: 'radius/control' }, [icon('home', t[2], 18)]);
      c.children[0].name = 'icon';
    } else {
      body(c, { dir: 'H', w: 224, h: 36, px: 'space/2-5', gap: 'space/2-5', align: 'center', fill: t[0], radius: 'radius/control' }, [
        icon('home', t[2], 18), text('Home', t[3], t[1], { name: 'label', sizeH: 'FILL' }), inst('CountBadge', { Tone: 'Attention', Count: '3' }, { name: 'count' }), icon('chevron-down', 'icon/muted', 16),
      ]);
      c.children[0].name = 'icon'; c.children[3].name = 'chevron';
      safe('expose count', function () { c.children[2].isExposedInstance = true; });
    }
  }, { width: 760, desc: 'Sidebar item. Collapsed shows the icon only (tablet).', text: [{ prop: 'Label', node: 'label', def: 'Home' }], bool: [{ prop: 'Show count', node: 'count', def: false }, { prop: 'Show chevron', node: 'chevron', def: false }], swap: [{ prop: 'Icon', node: 'icon', def: 'home' }] });
  componentBlock(root, navItem, { title: 'NavItem', summary: 'Active item uses bg/selected and text/link; a parent of the active child is bold.', a11y: ['aria-current="page" on the active item.', 'Collapsed items show the label as a tooltip.'] });

  const sub = makeSet('NavSubItem', { State: ['Default', 'Active'] }, function (c, p) {
    const on = p.State === 'Active';
    body(c, { dir: 'H', w: 224, h: 32, pad: [0, 10, 0, 38], align: 'center', fill: on ? 'bg/selected' : null, radius: 'radius/control' }, [text('All orders', on ? 'Body/Strong' : 'Body/Default', on ? 'text/link' : 'text/secondary', { name: 'label' })]);
  }, { width: 520, desc: 'Child link under an expanded NavItem. Indented 38 px; Active uses bg/selected and text/link.', text: [{ prop: 'Label', node: 'label', def: 'All orders' }] });
  const grp = makeComponent('NavGroupLabel', function (c) {
    body(c, { dir: 'H', w: 224, pad: [16, 10, 6, 10] }, [text('Commerce', 'Caption/Overline', 'text/muted', { name: 'label' })]);
  }, { desc: 'Uppercase overline that groups navigation items (Commerce, Trust, Money). Hidden when the sidebar is collapsed.', text: [{ prop: 'Label', node: 'label', def: 'Commerce' }] });
  const subWrap = frame({ name: 'Sub items', dir: 'H', gap: 'space/6', align: 'start' }, [sub, frame({ name: 'Group label', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }, [grp])]);
  componentBlock(root, subWrap, { title: 'NavSubItem · NavGroupLabel', summary: 'Children appear under the active parent only. Group labels are uppercase overlines.' });

  brandMarkBlock(root);

  const sidebar = makeSet('Sidebar', { Workspace: ['Admin', 'Seller'], Collapsed: ['False', 'True'] }, function (c, p) {
    const col = p.Collapsed === 'True';
    body(c, { dir: 'V', w: col ? 'size/sidebar-collapsed' : 'size/sidebar', h: 900, fill: 'bg/surface', stroke: 'border/default', sides: ['right'] }, []);
    // Release 1.7.0: the brand is a BrandMark instance (Update library leaves the Sidebar of an existing file as it is).
    add(c, frame({ name: 'brand', dir: 'H', h: 64, px: 'space/4', gap: 'space/2-5', align: 'center', justify: col ? 'center' : 'start', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [
      inst('BrandMark', col ? { 'Show wordmark': false } : { Panel: p.Workspace === 'Admin' ? 'Admin' : 'Seller Centre' }, { name: 'brand-mark' }),
    ]));
    if (p.Workspace === 'Seller' && !col) {
      add(c, frame({ name: 'shop-switcher', dir: 'H', pad: [12, 12, 4, 12], sizeH: 'FILL' }, [frame({ name: 'button', dir: 'H', h: 40, px: 'space/2-5', gap: 'space/2', align: 'center', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
        inst('IdentityTile', { Tone: 'Teal', Shape: 'Rounded', Initials: 'KF' }), text('Kuraby Fresh', 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), icon('chevron-down', 'icon/muted', 16),
      ])]));
      const sw = c.children[1].children[0].children[0]; sw.resize(22, 22);
    }
    const list = frame({ name: 'items', dir: 'V', gap: 'space/0-5', pad: 'space/3', sizeH: 'FILL', sizeV: 'FILL', align: col ? 'center' : 'start' });
    NAV[p.Workspace].forEach(function (it, i) {
      if (it[0] === 'g') { if (!col) add(list, inst('NavGroupLabel', { Label: it[1] }, { name: 'group-' + it[1].toLowerCase() })); return; }
      if (it[0] === 'sub') { if (!col) add(list, inst('NavSubItem', { State: 'Default', Label: it[1] }, { name: it[2] })); return; }
      const props = { State: i === 0 ? 'Active' : 'Default', Collapsed: col ? 'True' : 'False', Icon: { icon: it[2] } };
      if (!col) { props.Label = it[1]; props['Show count'] = !!it[3]; props['Show chevron'] = !!it[4]; }
      const n = inst('NavItem', props, { name: it[0] });
      if (!col && it[3]) { const b = n.findOne(function (x) { return x.name === 'count'; }); b.setProperties({ Tone: it[3][0] }); const cp = {}; cp[S.sets.CountBadge.keys.Count] = it[3][1]; b.setProperties(cp); }
      add(list, n);
    });
    add(c, list);
    const foot = frame({ name: 'footer', dir: 'V', gap: 'space/0-5', pad: 'space/3', stroke: 'border/default', sides: ['top'], sizeH: 'FILL', align: col ? 'center' : 'start' }, [
      inst('NavItem', col ? { State: 'Default', Collapsed: 'True', Icon: { icon: 'help-circle' } } : { State: 'Default', Collapsed: 'False', Icon: { icon: 'help-circle' }, Label: 'Help & resources' }, { name: 'nav-help' }),
      inst('NavItem', col ? { State: 'Default', Collapsed: 'True', Icon: { icon: 'panel-left' } } : { State: 'Default', Collapsed: 'False', Icon: { icon: 'panel-left' }, Label: 'Collapse' }, { name: 'nav-collapse' }),
    ]);
    add(c, foot);
  }, { width: 1200, gapX: 40, desc: 'The shared sidebar. Swap the active item with the nested NavItem State. Menu items follow permissions in code.' });
  componentBlock(root, sidebar, { title: 'Sidebar', summary: 'Admin and Seller differ only in items. Collapsed (72 px) is used on the tablet order board.' });

  const topbar = makeSet('Topbar', { Workspace: ['Admin', 'Seller'] }, function (c, p) {
    const admin = p.Workspace === 'Admin';
    body(c, { dir: 'H', w: 1192, h: 'size/topbar', px: 'space/6', gap: 'space/4', align: 'center', fill: 'bg/surface', stroke: 'border/default', sides: ['bottom'] }, [
      frame({ name: 'breadcrumb', dir: 'H', gap: 'space/2', align: 'center' }, [text(admin ? 'Admin' : 'Seller Centre', 'Body/Default', 'text/muted'), icon('chevron-right', 'icon/muted', 14), text('Home', 'Body/Strong', 'text/primary', { name: 'crumb' })]),
      frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }),
      frame({ name: 'search', dir: 'H', w: 340, h: 38, px: 'space/2-5', gap: 'space/2-5', align: 'center', fill: 'bg/page', stroke: 'border/default', radius: 'radius/control' }, [
        icon('search', 'icon/muted', 16), text(admin ? 'Search sellers, orders, products…' : 'Search orders, offers, customers…', 'Body/Default', 'text/muted', { sizeH: 'FILL', truncate: true }),
        frame({ name: 'kbd', dir: 'H', px: 'space/1-5', py: 1, fill: 'bg/surface', stroke: 'border/control', radius: 5 }, [text('Ctrl K', 'Mono/Small', 'text/secondary')]),
      ]),
      frame({ name: 'market', dir: 'H', h: 32, pad: [0, 10, 0, 4], gap: 'space/2', align: 'center', stroke: 'border/default', radius: 'radius/pill' }, [
        frame({ name: 'AU', dir: 'H', h: 24, px: 'space/2', align: 'center', fill: 'text/primary', radius: 'radius/pill' }, [text('AU', 'Caption/Strong', 'bg/surface')]), text('AUD · Brisbane AEST', 'Body/Small', 'text/secondary'),
      ]),
      frame({ name: 'notifications', w: 38, h: 38 }, [icon('bell', 'icon/default', 20)]),
      rect({ name: 'divider', w: 1, h: 28, fill: 'border/default' }),
      frame({ name: 'user', dir: 'H', gap: 'space/2-5', align: 'center' }, [
        inst('IdentityTile', { Tone: 'Blue', Shape: 'Circle', Initials: admin ? 'LH' : 'YK' }), frame({ name: 'who', dir: 'V' }, [text(admin ? 'Layla Haddad' : 'Yusuf Karimi', 'Body/Strong'), text(admin ? 'Compliance lead' : 'Shop owner', 'Caption/Default', 'text/muted')]),
      ]),
    ]);
    const bell = c.findOne(function (n) { return n.name === 'notifications'; }); const bi = bell.children[0]; bi.x = 9; bi.y = 9;
    const badge = inst('CountBadge', { Tone: 'Critical', Count: '4' }, { name: 'unread' }); bell.appendChild(badge); badge.x = 20; badge.y = 2;
  }, { width: 1260, desc: TOPBAR_DESC, text: [{ prop: 'Crumb', node: 'crumb', def: 'Home' }], bool: TOPBAR_BOOLS });
  componentBlock(root, topbar, { title: 'Topbar', summary: 'Market context (AU · AUD · AEST) is always visible because times and money depend on it.', props: ['Workspace: Admin or Seller', 'Crumb (text)', 'Show search, Show notifications (boolean, 1.7.0): off in the limited seller shell (S1)'] });
  menuBlock(root, {});
  showcaseBlock(root);
  buildMobileNav(root, {});
  tag(root);
}

// ---------------------------------------------------------------- mobile navigation (release 1.5.0, D16; PhoneTopbar added in 1.6.0)
// Below 760 px: both panels open the nav config as a drawer; the seller panel also gets a bottom tab bar.
// Built by "Build library" and added to an existing file by "Update library" (see 50_main.js).
function drawerRow(it, active) {
  const kids = [icon(it[2], active ? 'text/link' : 'icon/default', 20), text(it[1], active ? 'Touch/Strong' : 'Touch/Body', active ? 'text/link' : 'text/secondary', { name: 'label', sizeH: 'FILL', truncate: true })];
  if (it[3]) kids.push(inst('CountBadge', { Tone: it[3][0], Count: it[3][1] }, { name: 'count' }));
  if (it[4]) kids.push(icon('chevron-down', 'icon/muted', 16));
  const row = frame({ name: it[0], dir: 'H', h: 'size/control', px: 'space/3', gap: 'space/3', align: 'center', fill: active ? 'bg/selected' : null, radius: 'radius/control', sizeH: 'FILL' }, kids);
  return row;
}
const BAR_TABS = [['home', 'Home', 'home'], ['orders', 'Orders', 'clipboard'], ['catalogue', 'Catalogue', 'package'], ['more', 'More', 'more-horizontal']];
function buildMobileNav(root, have) {
  // have: names of sets that already exist in the file ("Update library" adds only what is missing).
  if (!have.PhoneTopbar) {
  const ptb = makeSet('PhoneTopbar', { Workspace: ['Admin', 'Seller'] }, function (c, p) {
    const admin = p.Workspace === 'Admin';
    const bell = frame({ name: 'notifications', w: 48, h: 48 }, [inst('IconButton', { Variant: 'Ghost', Size: 'Touch', State: 'Default', Icon: { icon: 'bell' } })]);
    const badge = inst('CountBadge', { Tone: 'Critical', Count: '4' }, { name: 'unread' }); bell.appendChild(badge); badge.x = 26; badge.y = 4;
    const mark = brandMark(28); mark.name = 'brand-mark';
    body(c, { dir: 'H', w: 360, h: 'size/topbar-phone', px: 'space/2', gap: 'space/2', align: 'center', fill: 'bg/surface', stroke: 'border/default', sides: ['bottom'] }, [
      inst('IconButton', { Variant: 'Ghost', Size: 'Touch', State: 'Default', Icon: { icon: 'menu' } }, { name: 'menu-button' }),
      mark,
      text(admin ? 'Admin' : 'Seller Centre', 'Heading/H2', 'text/primary', { name: 'panel-name', sizeH: 'FILL', truncate: true }),
      bell,
      frame({ name: 'account-button', dir: 'H', w: 48, h: 48, align: 'center', justify: 'center' }, [inst('IdentityTile', { Tone: 'Blue', Shape: 'Circle', Initials: admin ? 'LH' : 'YK' }, { name: 'account' })]),
    ]);
    // Count and Initials are properties of the nested CountBadge and IdentityTile; exposing them shows both on every PhoneTopbar instance.
    safe('expose count', function () { c.findOne(function (n) { return n.name === 'unread'; }).isExposedInstance = true; });
    safe('expose initials', function () { c.findOne(function (n) { return n.name === 'account'; }).isExposedInstance = true; });
  }, { width: 760, gapX: 40, desc: 'Phone top bar (below 760 px, D16) for both panels; the desktop Topbar is unchanged. 56 px high (size/topbar-phone), 360 wide here and fill width in screens. Auto layout, horizontal, 8 px side padding and 8 px gap, centred vertically, bg/surface with a bottom border/default. Workspace picks the panel name: Admin or Seller Centre. Layers in order: menu-button (IconButton Ghost, Touch, icon menu), brand-mark, panel-name (Heading/H2, fills the width, truncates), notifications (48 px frame: bell IconButton plus a Critical CountBadge at x26 y4) and account-button (48 px frame with a Circle IdentityTile). Count (CountBadge) and Initials (IdentityTile) are exposed from the nested instances. Accessibility: the bar is a <header> banner landmark. Menu button: aria-label "Open menu", aria-expanded, aria-controls the drawer id, aria-haspopup="dialog". Bell: label "Notifications, N unread". Account button: label "Account". Focus order is menu, notifications, account; when the drawer closes, focus returns to the menu button. RTL mirrors the layer order (the menu button sits at inline-start, the side the drawer opens from); icons do not mirror. The limited seller shell has no drawer, so it omits the menu-button slot (the brand mark then starts the bar). The acting-as banner sits below the topbar in the layout, never inside it, in every shell state; it is stacked above the scrim, the drawer and the bottom bar.' });
  componentBlock(root, ptb, { title: 'PhoneTopbar', summary: 'The 56 px bar at the top of every phone screen in both panels. The desktop Topbar (breadcrumb, search, market) is unchanged.',
    use: ['Below 760 px in the Admin and Seller panels, above the page content.', 'Phone landscape wider than 760 px uses the desktop Topbar and the 72 px rail.'],
    props: ['Workspace: Admin or Seller', 'Count: unread number on the bell (exposed from the nested CountBadge)', 'Initials: person initials (exposed from the nested IdentityTile)'],
    a11y: ['<header> banner landmark; the page has one banner.', 'Menu button: aria-label "Open menu", aria-expanded, aria-controls the drawer id, aria-haspopup="dialog".', 'Bell label "Notifications, N unread"; account button label "Account".', 'Focus order: menu, notifications, account. Focus returns to the menu button when the drawer closes.', 'RTL mirrors the layer order; icons do not mirror.'],
    dont: ['A menu-button slot on the limited seller shell (it has no drawer).', 'The acting-as banner inside the bar: it sits below the topbar in the layout and is stacked above the scrim, the drawer and the bottom bar.', 'panel-left for the menu button: that icon stays for the NavItem collapse.'] });
  }
  if (!have.NavDrawer) {
  const drawer = makeSet('NavDrawer', { Workspace: ['Admin', 'Seller'] }, function (c, p) {
    const seller = p.Workspace === 'Seller';
    withTouch(true, function () {
      body(c, { dir: 'V', w: 304, h: 780, fill: 'bg/surface', stroke: 'border/default', sides: ['right'], effect: 'Elevation/Floating' }, []);
      add(c, frame({ name: 'header', dir: 'H', h: 56, px: 'space/4', gap: 'space/2-5', align: 'center', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [
        brandMark(30),
        frame({ name: 'name', dir: 'V', sizeH: 'FILL' }, [text('MondaPac', 'Heading/H2'), text(seller ? 'Seller Centre' : 'Admin', 'Caption/Overline', 'text/muted')]),
        inst('IconButton', { Variant: 'Ghost', Size: 'Touch', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' }),
      ]));
      if (seller) {
        add(c, frame({ name: 'shop-switcher', dir: 'H', pad: [12, 12, 4, 12], sizeH: 'FILL' }, [frame({ name: 'button', dir: 'H', h: 'size/control', px: 'space/2-5', gap: 'space/2', align: 'center', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
          inst('IdentityTile', { Tone: 'Teal', Shape: 'Rounded', Initials: 'KF' }), text('Kuraby Fresh', 'Touch/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), icon('chevron-down', 'icon/muted', 16),
        ])]));
        const sw = c.children[1].children[0].children[0]; sw.resize(22, 22);
      }
      const list = frame({ name: 'items', dir: 'V', gap: 0, pad: 'space/3', sizeH: 'FILL', sizeV: 'FILL' });
      NAV[p.Workspace].forEach(function (it, i) {
        if (it[0] === 'g') { add(list, inst('NavGroupLabel', { Label: it[1] }, { name: 'group-' + it[1].toLowerCase(), sizeH: 'FILL' })); return; }
        if (it[0] === 'sub') {
          add(list, frame({ name: it[2], dir: 'H', h: 'size/control', pad: [0, 12, 0, 44], align: 'center', radius: 'radius/control', sizeH: 'FILL' }, [text(it[1], 'Touch/Body', 'text/secondary', { name: 'label', sizeH: 'FILL', truncate: true })]));
          return;
        }
        add(list, drawerRow(it, i === 0));
      });
      add(c, list);
      add(c, frame({ name: 'footer', dir: 'V', pad: 'space/3', stroke: 'border/default', sides: ['top'], sizeH: 'FILL' }, [drawerRow(['nav-help', 'Help & resources', 'help-circle'], false)]));
      touchMode(c);
    });
  }, { width: 760, desc: 'Phone navigation drawer (below 760 px, D16). Same nav groups and order as the Sidebar, so nothing is phone-only; Workspace picks Admin or Seller items. Opens from the inline-start edge (left in LTR, right in RTL), 304 wide, full height. Rows are 48 px (size/control under touch density). The header has the panel mark and a close icon button: aria-label "Close menu". Show it over a scrim (bg/scrim; the scrim belongs to the screen, not to this component): tapping the scrim, Esc or any link closes the drawer and focus returns to the menu button. While open the page behind is inert and the drawer is aria-modal with a focus trap. It renders only the already-filtered nav config. Seller opens it from the menu button or from More on the bottom tab bar.' });
  componentBlock(root, drawer, { title: 'NavDrawer', summary: 'Both panels open the same navigation as a drawer on phones. It is the Sidebar for widths below 760 px, in touch density.',
    use: ['Below 760 px, from the menu button in the 56 px topbar (Admin and Seller) or from More on the BottomTabBar (Seller).', 'Phone landscape wider than 760 px uses the 72 px rail instead; there is no rail below 760 px.'],
    props: ['Workspace: Admin or Seller', 'Close is an IconButton instance (Touch size)'],
    a11y: ['role="dialog" with aria-modal="true" and a label; the page behind is inert.', 'Focus moves into the drawer, is trapped, and returns to the menu button on close.', 'Esc, the scrim and any navigation close it.', 'Targets are 48 px; the active item uses aria-current="page".'],
    dont: ['Phone-only items: the drawer never has items the Sidebar lacks.', 'A disabled item for a missing permission: hidden items are removed from the config.'] });

  }

  if (!have.BottomTabBar) {
  const bar = makeSet('BottomTabBar', { Active: ['Home', 'Orders', 'Catalogue', 'More'], Tabs: ['4', '3'] }, function (c, p) {
    const tabs = BAR_TABS.filter(function (t) { return p.Tabs === '4' || t[0] !== 'orders'; });
    withTouch(true, function () {
      body(c, { dir: 'H', w: 360, h: 'size/bottom-bar', px: 'space/2', gap: 'space/1', align: 'center', fill: 'bg/surface', stroke: 'border/default', sides: ['top'] }, tabs.map(function (t) {
        const on = p.Active.toLowerCase() === t[0];
        const wrap = frame({ name: 'icon-wrap', w: 28, h: 24 });
        const ic = icon(t[2], on ? 'action/primary' : 'icon/default', 22); add(wrap, ic); ic.x = 3; ic.y = 1;
        if (t[0] === 'orders') { const b = inst('CountBadge', { Tone: 'Attention', Count: '9+' }, { name: 'orders-badge' }); add(wrap, b); b.x = 14; b.y = -6; }
        return frame({ name: 'tab-' + t[0], dir: 'V', h: 56, gap: 'space/0-5', align: 'center', justify: 'center', fill: on ? 'bg/selected' : null, radius: 'radius/control', sizeH: 'FILL' }, [wrap, text(t[1], on ? 'Caption/Strong' : 'Caption/Default', on ? 'text/link' : 'text/secondary', { name: 'label-' + t[0] })]);
      }));
      touchMode(c);
    });
  }, { width: 760, gapX: 40, skip: function (p) { return p.Tabs === '3' && p.Active === 'Orders'; }, desc: 'Seller phone bottom tab bar (below 760 px, D16): Home, Orders, Catalogue, More. 64 px high (size/bottom-bar), each tab an icon plus a visible label and a target of at least 48 px (56 here). Active picks the highlighted tab; Tabs=3 drops Orders (Home, Catalogue, More) for before Orders ships in phase 5. Orders shows the real count from the server-filtered badge source and caps at "9+" (the variants show the cap). Edge cases: (1) tabs come from the already-filtered nav config, so a missing permission means fewer tabs, never a disabled tab; the bar shows only when the user may see at least two of Home, Orders and Catalogue (before phase 5: Home and Catalogue), otherwise only the drawer is used. (2) The bar hides while the on-screen keyboard is open. (3) It respects the bottom safe area: the inset is added below the 64 px. (4) More opens the NavDrawer and shows as active while the drawer is open, and on any route that is not one of the tabs. (5) The limited seller shell has no bar and no drawer. (6) A future acting-as banner sits above the bar. Admin has no bottom bar. Each tab gets the Focus/Ring effect on keyboard focus.',
    bool: [{ prop: 'Show orders badge', node: 'orders-badge', def: true }] });
  componentBlock(root, bar, { title: 'BottomTabBar', summary: 'Seller only. One thumb tap between orders and stock beats opening the drawer each time. Admin keeps the drawer only.',
    use: ['Below 760 px in the seller panel, when the user may see at least two of Home, Orders and Catalogue.', 'Tabs=3 until the Orders module ships (phase 5): Home, Catalogue, More.'],
    props: ['Active: Home, Orders, Catalogue or More', 'Tabs: 4 or 3', 'Show orders badge (boolean)'],
    a11y: ['<nav> with aria-label; the active tab has aria-current="page"; More is a button that opens the drawer (aria-expanded).', 'Every tab has a visible label and a target of at least 48 px.', 'The badge is read as part of the label ("Orders, 9 or more waiting").', 'Hidden while the on-screen keyboard is open; respects the bottom safe area.'],
    dont: ['A disabled tab for a missing permission.', 'The bar on the limited seller shell, on Admin, or at 760 px and wider (the rail takes over).'] });
  }
}

// ---------------------------------------------------------------- shared definitions that Update library also uses (1.7.0)
const TOPBAR_DESC = 'Breadcrumb, command search (Ctrl K), market context, notifications and the user. Show search and Show notifications (1.7.0) hide those slots in the limited seller shell (S1).';
const TOPBAR_BOOLS = [{ prop: 'Show search', node: 'search', def: true }, { prop: 'Show notifications', node: 'notifications', def: true }];
const CHECKLIST_AXES = { State: ['Done', 'To do', 'Waiting', 'Needs attention'] };
const CHECKLIST_DESC_170 = 'One verification check or one step of a process. Automatic checks show when they ran; manual checks offer Confirm or Flag a problem. Waiting (1.7.0) is a step someone else is working on; Needs attention (1.7.0) is a step the user must act on. Show actions and Action (1.7.0) show one text action under the step; the To do buttons follow Show actions too.';
// 1.9.0 "Seller setup" (sellers ux.md section 4): a supporting line under the state word ("2 fields left") and a chevron for a step that opens a page.
const CHECKLIST_OPTS = { width: 1000, desc: CHECKLIST_DESC_170 + ' Show detail and Detail (1.9.0) add a supporting line such as "2 fields left"; Show chevron (1.9.0) marks a step that opens its own page (the whole row is the link, named by its title).',
  text: [{ prop: 'Title', node: 'title', def: 'Certificate number confirmed with the issuer' }, { prop: 'By', node: 'by', def: 'Needs a person' }, { prop: 'Action', node: 'action-label', def: 'Update your details' }, { prop: 'Detail', node: 'detail', def: '2 fields left' }],
  bool: [{ prop: 'Show actions', node: 'actions', def: true }, { prop: 'Show detail', node: 'detail', def: false }, { prop: 'Show chevron', node: 'chevron', def: false }] };
const CHECKLIST_DOC = { title: 'ChecklistItem', summary: 'Approve stays disabled until every check is done. Waiting and Needs attention mark the steps of a process, such as the seller application on S1.', props: ['Title, By (text)', 'Show actions (boolean) and Action (text, Waiting and Needs attention)', 'Show detail (boolean) and Detail (text), Show chevron (boolean), 1.9.0', 'State: Done, To do, Waiting, Needs attention'], a11y: ['The state is a word in By and an icon in the mark, never colour alone.', 'A step with a chevron is one link named by its title; the detail line is part of its description.'] };
// The 1.9.0 nodes: the detail line (after By) and the chevron (last in the row). Both start hidden, like their properties.
function checklistDetail() { const t = text('2 fields left', 'Caption/Default', 'text/muted', { name: 'detail' }); t.visible = false; return t; }
function checklistChevron() { const f = frame({ name: 'chevron', dir: 'H', pad: [1, 0, 0, 0] }, [icon('chevron-right', 'icon/muted', 18)]); f.visible = false; return f; }
const CK_MARK = { Done: ['status/success/fg', null, 'check', 'text/on-accent'], 'To do': ['bg/surface', 'border/input', null, null], Waiting: ['status/info/bg', null, 'clock', 'status/info/fg'], 'Needs attention': ['status/attention/bg', null, 'alert-circle', 'status/attention/fg'] };
const CK_BY = { Done: ['Checked automatically · 29 Sep, 10:25 am', 'text/muted', 'Caption/Default'], 'To do': ['Needs a person', 'text/muted', 'Caption/Default'], Waiting: ['In progress', 'status/info/fg', 'Caption/Strong'], 'Needs attention': ['Needs changes', 'status/attention/fg', 'Caption/Strong'] };
function checklistVariant(c, p) {
  const m = CK_MARK[p.State]; const by = CK_BY[p.State];
  const mark = frame({ name: 'mark', dir: 'H', w: 22, h: 22, align: 'center', justify: 'center', fill: m[0], stroke: m[1], strokeW: 1.5, radius: 'radius/pill' }, [m[2] ? icon(m[2], m[3], 13) : null]);
  let actions = null;
  if (p.State === 'To do') actions = frame({ name: 'actions', dir: 'H', gap: 'space/1-5' }, [inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Confirm' }), inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Flag a problem' })]);
  if (p.State === 'Waiting' || p.State === 'Needs attention') actions = frame({ name: 'actions', dir: 'H', gap: 'space/1-5' }, [text('Update your details', 'Body/Small Strong', 'text/link', { name: 'action-label' })]);
  body(c, { dir: 'H', w: 380, pad: [12, 18, 12, 18], gap: 'space/2-5', align: 'start', stroke: 'border/row', sides: ['top'] }, [
    mark,
    frame({ name: 'content', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [
      text('Certificate number confirmed with the issuer', 'Body/Default', 'text/primary', { name: 'title', sizeH: 'FILL' }),
      text(by[0], by[2], by[1], { name: 'by' }),
      checklistDetail(),
      actions,
    ]),
    checklistChevron(),
  ]);
}

// ---------------------------------------------------------------- review & detail
async function buildReview(page) {
  const root = pageShell(page, 'Review & detail', 'Building blocks of the review workspace: queue summary cards, extracted document fields, checks and the activity timeline.');
  const QC = { 'On track': ['Success', 'On track', 'Accent', '75', 'Oldest 2 days of 3'], Overdue: ['Critical', '1 overdue', 'Critical', '100', 'Oldest 2 days 4 h of 2 days'], 'Due today': ['Attention', 'Due today', 'Accent', '50', 'Oldest 4 h · due 5:00 pm'] };
  const qc = makeSet('QueueCard', { Tone: Object.keys(QC) }, function (c, p) {
    const q = QC[p.Tone];
    body(c, { dir: 'V', w: 264, pad: 18, gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [
      frame({ name: 'head', dir: 'H', gap: 'space/2', align: 'center', justify: 'between', sizeH: 'FILL' }, [text('Certifications', 'Body/Strong', 'text/secondary', { name: 'title' }), inst('Badge', { Tone: q[0], Leading: 'Dot', Label: q[1] })]),
      frame({ name: 'count-row', dir: 'H', gap: 'space/2', align: 'baseline' }, [text('4', 'Display/Hero', 'text/primary', { name: 'count' }), text('waiting', 'Body/Default', 'text/muted', { name: 'unit' })]),
      inst('Meter', { Tone: q[2], Value: q[3] }, { name: 'meter', sizeH: 'FILL' }),
      frame({ name: 'foot', dir: 'H', justify: 'between', sizeH: 'FILL' }, [text(q[4], 'Body/Small', 'text/muted', { name: 'oldest' }), text('Review', 'Body/Small Strong', 'text/link')]),
    ]);
  }, { width: 1000, desc: 'Summary of one review queue with its deadline meter.', text: [{ prop: 'Title', node: 'title', def: 'Certifications' }, { prop: 'Count', node: 'count', def: '4' }, { prop: 'Unit', node: 'unit', def: 'waiting' }, { prop: 'Oldest', node: 'oldest', def: 'Oldest 2 days of 3' }] });
  componentBlock(root, qc, { title: 'QueueCard', summary: 'The meter shows how much of the deadline the oldest item has used.' });

  const EF = { Matches: ['Matches ABN', 'Success', null], 'Check now': ['Check now', 'Info', 'action/primary'], 'To check': ['To check', 'Neutral', null] };
  const ef = makeSet('ExtractedField', { Status: Object.keys(EF) }, function (c, p) {
    const e = EF[p.Status];
    body(c, { dir: 'V', w: 260, pad: [10, 14, 10, 14], gap: 'space/1', fill: e[2] ? 'bg/row-selected' : 'bg/surface', stroke: e[2] ? 'action/primary' : 'border/row', sides: e[2] ? ['left'] : ['bottom'], strokeW: e[2] ? 3 : 1 }, [
      frame({ name: 'head', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Holder', 'Caption/Default', 'text/muted', { name: 'label' }), inst('Badge', { Tone: e[1], Leading: 'None', Label: e[0] })]),
      text('Kuraby Fresh Pty Ltd', 'Body/Strong', 'text/primary', { name: 'value', sizeH: 'FILL' }),
    ]);
  }, { width: 1000, desc: 'A value read from an uploaded document and whether it matches our records.', text: [{ prop: 'Label', node: 'label', def: 'Holder' }, { prop: 'Value', node: 'value', def: 'Kuraby Fresh Pty Ltd' }] });
  componentBlock(root, ef, { title: 'ExtractedField', summary: '"Check now" marks the field the reviewer is working on; it matches the highlight on the document.' });

  const ck = makeSet('ChecklistItem', CHECKLIST_AXES, checklistVariant, CHECKLIST_OPTS);
  componentBlock(root, ck, CHECKLIST_DOC);
  reasonQuoteBlock(root);
  dataRowBlock(root); // 1.9.0

  const TL = { Blue: ['action/primary', 'bg/selected'], Info: ['status/info/fg', 'status/info/bg'], Neutral: ['status/neutral/fg', 'status/neutral/bg'], Teal: ['cert/seller/fg', 'cert/seller/tile'] };
  const tl = makeSet('TimelineItem', { Tone: Object.keys(TL) }, function (c, p) {
    const t = TL[p.Tone];
    const d = frame({ name: 'dot', w: 32, h: 32 }); d.fills = [];
    add(d, ellipse({ name: 'halo', w: 18, fill: t[1], xy: [7, 7] })); add(d, ellipse({ name: 'core', w: 10, fill: t[0], xy: [11, 11] }));
    body(c, { dir: 'H', w: 640, gap: 'space/2-5', align: 'start', pad: [0, 0, 14, 0] }, [
      d,
      frame({ name: 'content', dir: 'V', gap: 'space/1', pad: [6, 0, 0, 0], sizeH: 'FILL' }, [
        frame({ name: 'line', dir: 'H', gap: 'space/1', wrap: true, sizeH: 'FILL' }, [text('Layla Haddad', 'Body/Strong', 'text/primary', { name: 'who' }), text('confirmed the name and ABN', 'Body/Default', 'text/secondary', { name: 'what' })]),
        frame({ name: 'quote', dir: 'H', pad: [8, 10, 8, 10], fill: 'bg/page', stroke: 'border/row', radius: 'radius/control', sizeH: 'FILL' }, [text('We received your renewal. The review is taking longer than usual this week.', 'Body/Small', 'text/secondary', { name: 'quote-text', sizeH: 'FILL' })]),
      ]),
      frame({ name: 'when-wrap', dir: 'H', pad: [7, 0, 0, 0] }, [text('Today, 2:12 pm', 'Caption/Default', 'text/muted', { name: 'when' })]),
    ]);
  }, { width: 1400, desc: 'One event in the activity timeline. Internal notes are never shown to sellers.', text: [{ prop: 'Who', node: 'who', def: 'Layla Haddad' }, { prop: 'What', node: 'what', def: 'confirmed the name and ABN' }, { prop: 'When', node: 'when', def: 'Today, 2:12 pm' }, { prop: 'Quote', node: 'quote-text', def: 'We received your renewal. The review is taking longer than usual this week.' }], bool: [{ prop: 'Show quote', node: 'quote', def: false }] });
  componentBlock(root, tl, { title: 'TimelineItem', summary: 'Tone shows who acted: Blue = staff, Info = MondaPac messages, Neutral = automatic, Teal = seller.' });
  tag(root);
}

// ---------------------------------------------------------------- board & delivery
async function buildBoard(page) {
  const root = pageShell(page, 'Board & delivery', 'Touch-density components for the seller order board, and the live delivery map.');
  const OC = { Urgent: ['MP-10482', 'Instant', 'ready by 2:50 pm', 'Waiting 9 min · accept now', 'status/critical/fg', 'Critical', '20', [['meat', 'Lamb cutlets', '500 g'], ['poultry', 'Chicken wings', '1 kg']], ['Accept', 'Item unavailable']],
    Normal: ['MP-10483', 'Instant', 'ready by 2:55 pm', 'Waiting 4 min', 'status/attention/fg', 'Attention', '25', [['poultry', 'Chicken thigh fillets', '1 kg']], ['Accept', 'Item unavailable']],
    Preparing: ['MP-10481', 'Instant', 'ready by 2:48 pm', 'Accepted 2:15 pm', 'text/muted', 'Attention', '18', [['meat', 'Lamb mince, 500 g', '× 2'], ['bakery', 'Turkish bread', '× 1']], ['Mark ready']],
    Ready: ['MP-10476', 'Courier', 'arriving 2:41 pm', 'Packed · 2 items · 1 bag', 'text/muted', 'Success', '11', [], ['Handed over', 'Print bag label']] };
  const card = makeSet('OrderCard', { Variant: Object.keys(OC) }, function (c, p) {
    const o = OC[p.Variant];
    withTouch(true, function () {
      body(c, { dir: 'V', w: 320, pad: 'space/3-5', gap: 'space/2-5', fill: 'bg/surface', stroke: p.Variant === 'Urgent' ? 'status/critical/solid' : 'border/default', radius: 'radius/card', effect: p.Variant === 'Urgent' ? 'Ring/Urgent' : null }, [
        frame({ name: 'head', dir: 'H', gap: 'space/2', align: 'start', justify: 'between', sizeH: 'FILL' }, [
          frame({ name: 'ids', dir: 'V', gap: 'space/1' }, [text(o[0], 'Mono/Touch', 'text/primary', { name: 'order' }), frame({ name: 'mode', dir: 'H', gap: 'space/1' }, [text(o[1], 'Touch/Strong', 'text/primary'), text('· ' + o[2], 'Touch/Body', 'text/secondary', { name: 'window' })]), text(o[3], 'Body/Small Strong', o[4], { name: 'status' })]),
          inst('CountdownRing', { Tone: o[5], Minutes: o[6] }, { name: 'countdown' }),
        ]),
        o[7].length ? frame({ name: 'lines', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, o[7].map(function (l) {
          return frame({ name: 'line', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [inst('ProductThumb', { Category: l[0].charAt(0).toUpperCase() + l[0].slice(1), Size: 'Sm' }), text(l[1], 'Touch/Body', 'text/secondary', { sizeH: 'FILL', truncate: true }), text(l[2], 'Touch/Strong', 'text/primary')]);
        })) : null,
        frame({ name: 'actions', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, o[8].map(function (a, i) { return inst('Button', { Variant: i === 0 ? 'Primary' : 'Secondary', Size: 'Touch', State: 'Default', Label: a }, { sizeH: 'FILL' }); })),
      ]);
      touchMode(c);
    });
  }, { width: 1440, desc: 'Order card on the tablet board. Touch density: 48 px actions, 14–15 px text.', text: [{ prop: 'Order', node: 'order', def: 'MP-10482' }] });
  // Window and status wording belongs to each variant (a text property would force one wording on all four).
  componentBlock(root, card, { title: 'OrderCard', summary: 'One decision per card. Urgent cards get a red border and ring; the countdown shows minutes left.', a11y: ['New orders are announced politely with an optional sound.', 'Actions are 48 px high.'] });

  const map = makeComponent('DeliveryMap', function (c) {
    c.layoutMode = 'NONE'; c.resize(400, 236); c.fills = [paint('map/land')]; c.clipsContent = true;
    const parts = [];
    parts.push(vector({ name: 'water', d: 'M 330 0 C 318 40 352 70 340 110 C 330 150 360 180 350 236 L 400 236 L 400 0 Z', fill: 'map/water', closed: true }));
    parts.push(vector({ name: 'river', d: 'M 0 64 C 40 60 70 92 110 84 C 150 76 160 50 196 62 C 226 72 206 102 232 108 C 262 114 268 86 296 92 C 318 97 326 84 338 80', stroke: 'map/water', strokeW: 7 }));
    ['M 0 140 L 400 120', 'M 150 0 L 210 236', 'M 60 236 L 300 20'].forEach(function (d) { parts.push(vector({ name: 'road', d: d, stroke: 'map/road', strokeW: 1.2 })); });
    parts.push(vector({ name: 'service-area', d: 'M 24 30 Q 200 -10 316 34 Q 336 140 300 222 Q 160 246 60 214 Q 12 130 24 30 Z', fill: 'action/primary', fillOpacity: 0.04, stroke: 'action/primary', strokeW: 1.2, dash: [4, 4], closed: true }));
    ['M 268 182 Q 250 150 262 128', 'M 226 168 Q 200 150 214 118', 'M 112 150 Q 150 130 196 112', 'M 252 206 Q 290 196 300 160', 'M 230 110 Q 250 104 272 118'].forEach(function (d) { parts.push(vector({ name: 'route', d: d, stroke: 'action/primary', strokeW: 1.4, dash: [3, 3] })); });
    [['Brisbane CBD', 178, 42], ['Woolloongabba', 170, 90], ['Holland Park', 272, 112], ['Moorooka', 140, 136], ['Darra', 88, 160], ['Sunnybank', 176, 174], ['Kuraby', 278, 194], ['Logan Central', 190, 214], ['Moreton Bay', 330, 12]].forEach(function (l) { parts.push(text(l[0], 'Mono/Small', 'text/muted', { xy: [l[1], l[2]] })); });
    [[268, 182], [226, 168], [112, 150], [252, 206], [230, 110], [196, 128], [262, 128]].forEach(function (pt) { parts.push(ellipse({ name: 'seller', w: 12, fill: 'map/seller-pin', stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [pt[0] - 6, pt[1] - 6] })); });
    [[258, 150], [206, 140], [156, 128], [290, 186], [251, 106]].forEach(function (pt) { parts.push(ellipse({ name: 'courier-halo', w: 18, fill: 'map/courier', fillOpacity: 0.16, xy: [pt[0] - 9, pt[1] - 9] })); parts.push(ellipse({ name: 'courier', w: 8, fill: 'map/courier', stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [pt[0] - 4, pt[1] - 4] })); });
    parts.forEach(function (n) { add(c, n); n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; });
  }, { desc: 'Stylised Greater Brisbane map: service area, sellers with open orders, couriers. Production uses a map provider (D13) with these tokens; customer addresses are never shown.' });
  const mapWrap = frame({ name: 'DeliveryMap', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(mapWrap, map);
  componentBlock(root, mapWrap, { title: 'DeliveryMap', summary: 'Always shown with its legend and the three live numbers (in transit, average delivery, late now).', a11y: ['role="img" with a summary; pins have tooltips with the seller name.'] });
  tag(root);
}

// ==== 33_components_auth.js ====
// ---------------------------------------------------------------- release 1.7.0 "Auth" components (identity ux.md section 4, planned there as 1.1.0)
// BrandMark, Field, ReasonQuote, MenuItem + Menu and AuthShowcase. Built by "Build library" on their library pages and
// added to an existing file by "Update library" (see 50_main.js). Each block function returns the new set or component.

// ---- BrandMark (Navigation & shell): the mark plus the MondaPac wordmark and the panel name
function brandMarkBlock(root) {
  const bm = makeComponent('BrandMark', function (c) {
    const mark = brandMark(30); mark.name = 'mark';
    body(c, { dir: 'H', gap: 'space/2-5', align: 'center' }, [
      mark,
      frame({ name: 'wordmark', dir: 'V' }, [text('MondaPac', 'Heading/H2', 'text/primary', { name: 'brand-name' }), text('Admin', 'Caption/Overline', 'text/muted', { name: 'panel' })]),
    ]);
  }, { desc: 'The MondaPac mark (30 px, action/primary with the letter M), the wordmark and the panel name. Used by the Sidebar header and at the top of the form column on every Auth screen. Panel is the panel name (Admin or Seller Centre); Show wordmark off leaves the mark alone (collapsed sidebar); Show panel off leaves the wordmark without the panel line. Decorative next to a visible panel name; otherwise the link around it is named "MondaPac home".',
    text: [{ prop: 'Panel', node: 'panel', def: 'Admin' }], bool: [{ prop: 'Show wordmark', node: 'wordmark', def: true }, { prop: 'Show panel', node: 'panel', def: true }] });
  const wrap = frame({ name: 'BrandMark', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, bm);
  componentBlock(root, wrap, { title: 'BrandMark', summary: 'One brand mark for the Sidebar and the Auth template (1.7.0). A Sidebar in a file updated from an earlier release keeps its drawn mark; a new build uses this instance.',
    props: ['Panel (text): Admin or Seller Centre', 'Show wordmark (boolean)', 'Show panel (boolean)'],
    a11y: ['The mark is decorative when the panel name is visible next to it.', 'As a home link it is named "MondaPac home".'] });
  return bm;
}

// 1.7.0 said "Select or Textarea from 1.2.0"; the Panel release is numbered 1.8.0 and adds both. Update library refreshes the description only while it holds the 1.7.0 text.
const FIELD_DESC_180 = 'A form field: Label, an optional "(optional)" mark, the control, a helper line, a character counter and an error message with an icon. Control is an INSTANCE_SWAP slot (exposed): it takes Input today and Select or Textarea from 1.8.0; set the nested Input\'s Type, State and Value from the Field instance. Show error goes with the control\'s State=Error. Accessibility: the label is a <label> for the control; helper and error are tied to it with aria-describedby and the control gets aria-invalid; errors are text with an icon, never colour alone; optional fields say "(optional)", no asterisks.';
const FIELD_DESC_170 = FIELD_DESC_180.replace('Select or Textarea from 1.8.0', 'Select or Textarea from 1.2.0');
// 1.9.0 "Seller setup": the status line (FieldStatus) under the control. Update library refreshes the description only while it holds the 1.8.0 text.
const FIELD_DESC = FIELD_DESC_180 + ' Show status (1.9.0) shows a FieldStatus line under the control (exposed as "status"; set its Tone and Text from the Field instance) for a check that runs after the person types or saves: Checking, Success, Info or Critical. It is tied to the control with aria-describedby like the helper; Checking is a role="status" region.';
// ---- Field (Forms & selection): label, optional mark, the control slot, helper, counter and error
function fieldBlock(root) {
  const control = S.sets.Input.set.children.filter(function (v) { const vp = v.variantProperties; return vp.State === 'Default' && (vp.Type === undefined || vp.Type === 'Text'); })[0];
  const f = makeComponent('Field', function (c) {
    body(c, { dir: 'V', w: 360, gap: 'space/1-5' }, [
      frame({ name: 'label-row', dir: 'H', gap: 'space/1', align: 'center' }, [text('Email', 'Body/Strong', 'text/primary', { name: 'label' }), text('(optional)', 'Body/Default', 'text/muted', { name: 'optional' })]),
      inst('Input', { Type: 'Text', State: 'Default' }, { name: 'control', sizeH: 'FILL' }),
      fieldStatusSlot(),
      frame({ name: 'helper-row', dir: 'H', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [text('You’ll sign in with this email.', 'Caption/Default', 'text/muted', { name: 'helper', sizeH: 'FILL' }), text('0 / 500', 'Caption/Default', 'text/muted', { name: 'counter' })]),
      frame({ name: 'error', dir: 'H', gap: 'space/1-5', align: 'start', sizeH: 'FILL' }, [icon('alert-circle', 'status/critical/fg', 16), text('Enter your email.', 'Body/Small', 'status/critical/fg', { name: 'error-text', sizeH: 'FILL' })]),
    ]);
    c.children[4].children[0].name = 'error-icon';
    safe('expose control', function () { c.children[1].isExposedInstance = true; c.children[2].isExposedInstance = true; });
  }, { desc: FIELD_DESC,
    text: [{ prop: 'Label', node: 'label', def: 'Email' }, { prop: 'Helper', node: 'helper', def: 'You’ll sign in with this email.' }, { prop: 'Counter', node: 'counter', def: '0 / 500' }, { prop: 'Error', node: 'error-text', def: 'Enter your email.' }],
    bool: [{ prop: 'Optional', node: 'optional', def: false }, { prop: 'Show helper', node: 'helper', def: true }, { prop: 'Show counter', node: 'counter', def: false }, { prop: 'Show error', node: 'error', def: false }, { prop: 'Show status', node: 'status', def: false }],
    swap: [{ prop: 'Control', node: 'control', comp: control }] });
  const wrap = frame({ name: 'Field', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, f);
  componentBlock(root, wrap, { title: 'Field', summary: 'Every form control in a form sits in a Field (1.7.0): the label above, helper and counter below, the error under the control.',
    use: ['Every input of the Auth screens and of forms inside the shell.', 'Turn on Show error together with the control\'s State=Error; the error summary above the form repeats it.'],
    props: ['Label, Helper, Counter, Error (text)', 'Optional, Show helper, Show counter, Show error (boolean)', 'Show status (boolean, 1.9.0): the exposed FieldStatus line under the control', 'Control (instance swap; Input, Select or Textarea since 1.8.0)'],
    a11y: ['<label for>; helper and error via aria-describedby; aria-invalid on error.', 'Errors are not announced on each keystroke.', '"(optional)" instead of asterisks.'],
    dont: ['A placeholder instead of a label.', 'Colour alone for the error.'] });
  return f;
}

// ---- ReasonQuote (Review & detail): a reason written by MondaPac, quoted exactly
function reasonQuoteBlock(root) {
  const rq = makeComponent('ReasonQuote', function (c) {
    body(c, { dir: 'V', w: 480, pad: 'space/4', gap: 'space/2', fill: 'bg/subtle', stroke: 'border/default', radius: 'radius/card' }, [
      text('Reason from MondaPac', 'Body/Small Strong', 'text/secondary', { name: 'label' }),
      frame({ name: 'quote', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [rect({ name: 'bar', w: 3, h: 40, fill: 'border/input', radius: 2, sizeV: 'FILL' }), text('Your Halal certificate is not readable. Upload a clear copy of all pages, then contact us to continue.', 'Body/Default', 'text/primary', { name: 'reason', sizeH: 'FILL' })]),
      text('Written on 6 Oct 2026', 'Caption/Default', 'text/muted', { name: 'date' }),
    ]);
  }, { desc: 'A reason MondaPac wrote to a seller, shown exactly as written with its date (A10, S1, and the read-only state of D4). Plain text with dir="auto" and its line breaks; never shown to staff who are not the Seller Owner; no reviewer name.',
    text: [{ prop: 'Label', node: 'label', def: 'Reason from MondaPac' }, { prop: 'Reason', node: 'reason', def: 'Your Halal certificate is not readable. Upload a clear copy of all pages, then contact us to continue.' }, { prop: 'Date', node: 'date', def: 'Written on 6 Oct 2026' }] });
  const wrap = frame({ name: 'ReasonQuote', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, rq);
  componentBlock(root, wrap, { title: 'ReasonQuote', summary: 'The reason for a decision about a seller (1.7.0). Label, the text exactly as written, and the date.',
    props: ['Label, Reason, Date (text)'], a11y: ['The reason is a <blockquote> with dir="auto"; line breaks are kept.'], dont: ['Internal notes or the reviewer\'s name.', 'Reason text in a URL, a page title or telemetry.'] });
  return rq;
}

// ---- MenuItem + Menu (Navigation & shell): the account menu and row action menus
const MI = { Default: [null, 'text/primary', 'icon/default'], Hover: ['bg/subtle', 'text/primary', 'icon/default'], Focus: [null, 'text/primary', 'icon/default'], Disabled: [null, 'text/muted', 'icon/muted'], Destructive: [null, 'status/critical/fg', 'status/critical/fg'], Selected: ['bg/selected', 'text/link', 'text/link'] };
function menuItemVariant(c, p) {
  const t = MI[p.State];
  body(c, { dir: 'H', w: 264, pad: [8, 10, 8, 10], gap: 'space/2-5', align: 'start', fill: t[0], radius: 'radius/control' }, [
    icon('user', t[2], 18),
    frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Account security', p.State === 'Selected' ? 'Body/Strong' : 'Body/Medium', t[1], { name: 'label', sizeH: 'FILL' }), text('Only the shop owner can do this.', 'Caption/Default', 'text/muted', { name: 'description', sizeH: 'FILL' })]),
    p.State === 'Selected' ? icon('check', 'text/link', 16) : null,
  ]);
  c.children[0].name = 'icon';
  if (p.State === 'Selected') c.children[2].name = 'check';
  if (p.State === 'Focus') focusRing(c);
}
function menuBlock(root, have) {
  let item = have.MenuItem;
  if (!item) {
    item = makeSet('MenuItem', { State: ['Default', 'Hover', 'Focus', 'Disabled', 'Destructive', 'Selected'] }, menuItemVariant, { width: 920, desc: 'One item of a Menu or of a Select list. Label, a leading icon and an optional description line. Disabled items stay focusable and give their reason on the description line, so it can be read on touch. Destructive is for actions such as Suspend…; Selected marks the chosen option of a Select (check icon, bg/selected). Focus uses the Focus/Ring effect.',
      text: [{ prop: 'Label', node: 'label', def: 'Account security' }, { prop: 'Description', node: 'description', def: 'Only the shop owner can do this.' }],
      bool: [{ prop: 'Leading icon', node: 'icon', def: true }, { prop: 'Show description', node: 'description', def: false }], swap: [{ prop: 'Icon', node: 'icon', def: 'user' }] });
  }
  const menu = makeComponent('Menu', function (c) {
    body(c, { dir: 'V', w: 280, pad: 'space/1-5', gap: 'space/0-5', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, [
      frame({ name: 'header', dir: 'V', pad: [8, 10, 8, 10], sizeH: 'FILL' }, [text('Yusuf Karimi', 'Body/Strong', 'text/primary', { name: 'title', sizeH: 'FILL', truncate: true }), text('Shop owner', 'Caption/Default', 'text/muted', { name: 'subtitle', sizeH: 'FILL', truncate: true })]),
      inst('MenuItem', { State: 'Default', Label: 'Account security', Icon: { icon: 'lock' } }, { name: 'item-1', sizeH: 'FILL' }),
      inst('MenuItem', { State: 'Default', Label: 'Help & resources', Icon: { icon: 'help-circle' } }, { name: 'item-2', sizeH: 'FILL' }),
      rect({ name: 'divider', w: 200, h: 1, fill: 'border/default', sizeH: 'FILL' }),
      inst('MenuItem', { State: 'Default', Label: 'Sign out', Icon: { icon: 'log-out' } }, { name: 'item-3', sizeH: 'FILL' }),
    ]);
    ['item-1', 'item-2', 'item-3'].forEach(function (n) { safe('expose ' + n, function () { c.findOne(function (x) { return x.name === n; }).isExposedInstance = true; }); });
  }, { desc: 'A floating menu: an optional header (the person and their role) and up to three MenuItem slots with a divider before the last. Items are exposed, so each one\'s State, Label, Icon and description are set from the Menu instance. Used as the account menu of the Topbar (Account security, Help & resources, Sign out) and for row actions. Accessibility: role="menu" on a button with aria-haspopup and aria-expanded; arrow keys move, Esc closes and focus returns to the trigger; a row menu button is named "Actions for {name}".',
    text: [{ prop: 'Title', node: 'title', def: 'Yusuf Karimi' }, { prop: 'Subtitle', node: 'subtitle', def: 'Shop owner' }],
    bool: [{ prop: 'Show header', node: 'header', def: true }, { prop: 'Show item 2', node: 'item-2', def: true }, { prop: 'Show divider', node: 'divider', def: true }] });
  const wrap = frame({ name: 'Menu · MenuItem', dir: 'H', gap: 'space/6', align: 'start' }, [have.MenuItem ? null : item, frame({ name: 'Menu', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }, [menu])]);
  componentBlock(root, wrap, { title: 'Menu · MenuItem', summary: 'The account menu (sign out) and row action menus (1.7.0). A disabled item says why on its description line.',
    props: ['MenuItem: Label, Description (text); Leading icon, Show description (boolean); Icon (instance swap); State', 'Menu: Title, Subtitle (text); Show header, Show item 2, Show divider (boolean); item-1 to item-3 exposed'],
    a11y: ['role="menu" and role="menuitem"; disabled items stay focusable and show their reason.', 'Esc closes the menu and focus returns to its button.'],
    dont: ['A disabled item without a reason.', 'More than one destructive item without a divider.'] });
  return menu;
}

// ---- AuthShowcase (Navigation & shell): the static brand panel beside the Auth form column (ux.md 3.0 rule 1, design 1A)
const SHOWCASE = {
  Admin: { fill: 'bg/auth-showcase-admin', pill: 'MondaPac Admin', title: 'The whole marketplace, at a glance.', lede: 'Review sellers and certificates before deadlines, follow sales and keep every decision on the record.' },
  Seller: { fill: 'bg/auth-showcase-seller', pill: 'MondaPac Seller Centre', title: 'Your shop, ready before the first order.', lede: 'See every order the moment it lands, prepare on time and show customers your verified Halal certificate.' },
};
function scCard(name, w, kids) { return frame({ name: name, dir: 'V', w: w, pad: 'space/4', gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, kids); }
function scLines(a, b) { return frame({ name: 'lines', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(a, 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), text(b, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })]); }
function scVerified(note, tile, tileIcon, tileToken, title, sub) {
  return [
    frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [frame({ name: 'tile', dir: 'H', w: 36, h: 36, align: 'center', justify: 'center', fill: tile, radius: 'radius/pill' }, [icon(tileIcon, tileToken, 18)]), scLines(title, sub)]),
    frame({ name: 'proof', dir: 'H', gap: 'space/2', align: 'center' }, [inst('Badge', { Tone: 'Success', Leading: 'Icon', Label: 'Verified', Icon: { icon: 'check' } }), text(note, 'Caption/Default', 'text/muted')]),
  ];
}
// Two series on one scale: today (solid, chart/series-1) and the same day last week (dashed, chart/compare).
function scSparkline(w, h) {
  const today = [8, 10, 9, 12, 14, 13, 16, 18, 17, 21], before = [7, 8, 9, 9, 10, 11, 11, 12, 13, 13];
  const mn = 6, mx = 22; const pt = function (v, i) { return (2 + i * (w - 4) / (today.length - 1)).toFixed(1) + ' ' + (h - 2 - (v - mn) / (mx - mn) * (h - 4)).toFixed(1); };
  const f = frame({ name: 'sparkline', w: w, h: h }); f.fills = [];
  add(f, vector({ name: 'last week', d: 'M ' + before.map(pt).join(' L '), stroke: 'chart/compare', strokeW: 1.5, dash: [4, 3], xy: [0, 0] }));
  add(f, vector({ name: 'today', d: 'M ' + today.map(pt).join(' L '), stroke: 'chart/series-1', strokeW: 2, xy: [0, 0] }));
  return f;
}
function showcaseCards(ws) {
  if (ws === 'Admin') {
    const rows = [['CL', 'Teal', 'Cedar Lane Meats', 'Halal certificate renewal', 'Critical', 'Due 2h'], ['OG', 'Amber', 'Olive Grove Bakehouse', 'New seller · ABN check', 'Attention', 'Today'], ['RP', 'Neutral', 'Riverbend Poultry Co.', 'Manufacturer certificate', 'Neutral', 'Tomorrow']];
    return [
      scCard('Review queue', 360, [frame({ name: 'head', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Review queue', 'Body/Strong'), inst('Badge', { Tone: 'Attention', Leading: 'Dot', Label: '3 due today' })])].concat(rows.map(function (r) {
        return frame({ name: r[2], dir: 'H', gap: 'space/2-5', align: 'center', pad: [8, 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [inst('IdentityTile', { Tone: r[1], Shape: 'Rounded', Initials: r[0] }), scLines(r[2], r[3]), inst('Badge', { Tone: r[4], Leading: 'None', Label: r[5] })]);
      }))),
      scCard('Sales today', 232, [text('Sales today', 'Body/Small Strong', 'text/secondary'), frame({ name: 'value', dir: 'H', gap: 'space/2', align: 'end' }, [text('18,420', 'Heading/Stat'), text('+12%', 'Body/Small Strong', 'status/success/fg')]), scSparkline(200, 48)]),
      scCard('Certificate approved', 300, scVerified('Logged to audit trail', 'status/success/bg', 'check', 'status/success/fg', 'Certificate approved', 'Halal · seller level')),
    ];
  }
  const items = [['Meat', 'Lamb shoulder', '1.5 kg'], ['Poultry', 'Chicken thigh fillet', '2 kg'], ['Bakery', 'Lebanese bread', '×2']];
  const chip = frame({ name: 'chip-new', dir: 'H', h: 'size/badge', px: 'space/2', gap: 'space/1-5', align: 'center', fill: 'status/attention/bg', radius: 'radius/pill' }, [dot('status/attention/solid', 8), text('New', 'Caption/Strong', 'status/attention/fg')]);
  const seg = [['new', 44, 'status/attention/solid', '3 new'], ['packing', 58, 'chart/series-1', '4 packing'], ['ready', 102, 'status/success/fg', '7 ready']];
  return [
    scCard('Order ticket', 340, [
      frame({ name: 'head', dir: 'H', justify: 'between', align: 'start', sizeH: 'FILL' }, [frame({ name: 'ids', dir: 'V', gap: 'space/0-5' }, [text('#MP-1042', 'Mono/Default'), text('Prepare by 11:30', 'Body/Small', 'text/muted')]), chip]),
      frame({ name: 'items', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, items.map(function (it) { return frame({ name: it[1], dir: 'H', gap: 'space/2-5', align: 'center', sizeH: 'FILL' }, [inst('ProductThumb', { Category: it[0], Size: 'Sm' }), text(it[1], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true }), text(it[2], 'Body/Strong')]); })),
      inst('Button', { Variant: 'Primary', Size: 'Md', State: 'Default', Label: 'Mark as ready' }, { name: 'mark-ready', sizeH: 'FILL' }),
    ]),
    scCard('Today', 240, [
      text('Today', 'Body/Small Strong', 'text/secondary'), text('14 orders', 'Heading/Stat'),
      frame({ name: 'bar', dir: 'H', gap: 2 }, seg.map(function (s) { return rect({ name: s[0], w: s[1], h: 8, fill: s[2], radius: 2 }); })),
      frame({ name: 'legend', dir: 'H', gap: 'space/3', align: 'center' }, seg.map(function (s) { return frame({ name: s[0], dir: 'H', gap: 'space/1', align: 'center' }, [dot(s[2], 6), text(s[3], 'Caption/Default', 'text/secondary')]); })),
    ]),
    scCard('Halal certified seller', 300, scVerified('Checked by MondaPac', 'cert/seller/tile', 'badge-check', 'cert/seller/fg', 'Halal certified seller', 'Shown on all your products')),
  ];
}
const SHOWCASE_POS = { Admin: [[0, 36, -2], [352, 0, 0], [236, 262, 2.5]], Seller: [[0, 36, -2], [344, 0, 0], [260, 262, 2.5]] };
function showcaseVariant(c, p) {
  const d = SHOWCASE[p.Workspace];
  const pill = frame({ name: 'pill', dir: 'H', h: 28, px: 'space/3', gap: 'space/2', align: 'center', fill: 'bg/surface', radius: 'radius/pill' }, [dot('status/success/fg', 8), text(d.pill, 'Caption/Strong', 'text/primary', { name: 'panel' })]);
  const stage = frame({ name: 'cards', w: 592, h: 420 }); stage.fills = [];
  showcaseCards(p.Workspace).forEach(function (card, i) { const at = SHOWCASE_POS[p.Workspace][i]; add(stage, card); card.x = at[0]; card.y = at[1]; if (at[2]) card.rotation = at[2]; });
  const example = frame({ name: 'example', dir: 'H', h: 24, px: 'space/2-5', align: 'center', fill: 'text/on-showcase', fillOpacity: 0.14, radius: 'radius/pill' }, [text('Example', 'Caption/Strong', 'text/on-showcase')]);
  add(stage, example); example.x = 0; example.y = 0;
  body(c, { dir: 'V', w: 704, h: 900, pad: [56, 56, 40, 56], gap: 'auto', fill: d.fill, clip: true }, [
    frame({ name: 'brand-line', dir: 'V', gap: 'space/4' }, [pill, text(d.title, 'Display/Hero', 'text/on-showcase', { name: 'headline', w: 520 }), text(d.lede, 'Body/Default', 'text/on-showcase-muted', { name: 'lede', w: 480 })]),
    stage,
    frame({ name: 'footer', dir: 'H', sizeH: 'FILL' }, [text('Illustrative examples, not real stores', 'Caption/Default', 'text/on-showcase-muted', { name: 'place' })]),
  ]);
}
const SHOWCASE_SET_W = 1040; // one 704 px variant per row, so the set and its Usage panel fit the 1440 px page
function showcaseBlock(root) {
  const sc = makeSet('AuthShowcase', { Workspace: ['Admin', 'Seller'] }, showcaseVariant, { width: SHOWCASE_SET_W, gapX: 40, desc: 'The brand panel of the Auth template from 1024 px (identity ux.md 3.0 rule 1, design 1A): 55% of the width beside the form column. Workspace picks the panel colour (bg/auth-showcase-admin or bg/auth-showcase-seller, dark in both themes), the pill and the brand line in text/on-showcase and text/on-showcase-muted. Three overlapping example cards of the panel (bg/surface with the usual text tokens, two rotated by about 2°) carry a visible "Example" caption. Static and decorative: aria-hidden, no focusable element, no motion, the same for every state and account, no request of its own. Names are fictional, no real certifying body, no currency symbol; its words are copy keys identity.auth-showcase.*. Below 1024 px it is not in the page.' });
  componentBlock(root, sc, { title: 'AuthShowcase', summary: 'The static brand panel beside the sign-in form (1.7.0). The same on every Auth screen and state of one panel.',
    use: ['Only in the Auth template, at 1024 px and wider, filling the width beside the 45% form column.'],
    props: ['Workspace: Admin or Seller'],
    a11y: ['aria-hidden="true", no focusable element, live text rather than an image, no motion.', 'Brand line 4.5:1 or more on both panel colours (text/on-showcase-muted reaches 8.1:1).'],
    dont: ['Real store or certifier names, real admin routes or permissions.', 'Anything that varies by Market, account, state or URL.', 'A currency symbol in the figures.'] });
  return sc;
}

// ==== 34_components_panel.js ====
// ---------------------------------------------------------------- release 1.8.0 "Panel" components
// Select, Textarea, CheckboxRow (Forms & selection); Toast, DialogBody + Dialog (Status & feedback); EmptyState and the
// State=Loading variants of TableCell (Tables & collections). Spec: figma-1.2.0-spec.md (renumbered 1.8.0), section 2.
// Built by "Build library" on their library pages and added to an existing file by "Update library" (see 50_main.js).
// The page subtitles repeat the ones the build uses, so Update library can find (or, if missing, recreate) each page's root frame.
const PANEL_SUBTITLE = {
  'Forms & selection': 'Inputs, checkboxes, switches, segmented controls, tabs and filter chips.',
  'Status & feedback': 'Badges, status, certificates, health, deadlines, meters and banners. State is always a word plus a shape, never colour alone.',
  'Tables & collections': 'Index pages: header cells, cells by content type, pagination and the floating bulk action bar. Tables use real <table> markup in code.',
};
// The components 1.8.0 adds, by library page (hosts) in the order Update library builds them.
const PANEL_SETS = ['Select', 'Textarea', 'CheckboxRow', 'Toast', 'DialogBody', 'Dialog', 'EmptyState'];

// ---- Select (Forms & selection): the trigger of a single-choice list; the list is a Menu
const SELECT_AXES = { State: ['Default', 'Hover', 'Focus', 'Open', 'Filled', 'Disabled', 'Error'] };
const SELECT_OPTS = { width: 1040, desc: 'Single choice from a short list (role picker). This is the trigger only; the list is a Menu instance that a template or the code places below it with a 4 px gap, as wide as the trigger. Wrap it in Field for the label, helper and error. States: Default, Hover, Focus (Focus/Ring), Open (primary border, chevron turned 180 degrees, list shown), Filled, Disabled and Error. Value is the placeholder text, or the chosen text while Filled; Leading icon is off by default. Rows of the list are MenuItem instances: the name, a one-line description, and a trailing check on the selected row (MenuItem State=Selected); a choice the user may not make is a disabled MenuItem with its reason on the description line. Code builds a listbox, not a native <select>.',
  text: [{ prop: 'Value', node: 'value', def: 'Select a role' }], bool: [{ prop: 'Leading icon', node: 'icon-leading', def: false }], swap: [{ prop: 'Icon', node: 'icon-leading', def: 'user' }] };
function selectVariant(c, p) {
  const border = { Error: 'status/critical/solid', Focus: 'action/primary', Open: 'action/primary', Hover: 'text/muted' }[p.State] || 'border/input';
  const filled = p.State === 'Filled';
  body(c, { dir: 'H', w: 280, h: 'size/control', pad: [0, 'space/2-5', 0, 'space/2-5'], gap: 'space/2', align: 'center', fill: p.State === 'Disabled' ? 'bg/muted' : 'bg/surface', stroke: border, radius: 'radius/control' }, [
    icon('user', 'icon/muted', 16),
    text(filled ? 'Seller reviewer' : 'Select a role', 'Body/Default', filled ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL', truncate: true }),
    icon('chevron-down', 'icon/muted', 16),
  ]);
  c.children[0].name = 'icon-leading'; c.children[0].visible = false;
  c.children[2].name = 'chevron';
  if (p.State === 'Open') c.children[2].rotation = 180;
  if (p.State === 'Focus') focusRing(c);
}
function selectBlock(root) {
  const sel = makeSet('Select', SELECT_AXES, selectVariant, SELECT_OPTS);
  componentBlock(root, sel, { title: 'Select', summary: 'The trigger for a short list of choices (1.8.0). The list is a Menu; wrap the trigger in Field.',
    use: ['One choice from about 8 rows or fewer: the role picker in the invite and change-role dialogs.', 'Open shows the list below the trigger; the selected row has the check.'],
    props: ['Value (text), Leading icon (boolean), Icon (instance swap)', 'State: Default, Hover, Focus, Open, Filled, Disabled, Error'],
    a11y: ['Trigger role="combobox" with aria-haspopup="listbox", aria-expanded and aria-controls; the list is role="listbox" with role="option" rows and aria-selected.', 'Disabled options stay focusable with aria-disabled and their reason in the description, so touch users can read it.', 'Arrow keys move, Home and End jump, type-ahead, Enter selects, Esc closes and returns focus to the trigger.', 'Error uses aria-invalid and aria-describedby. Border contrast is 3:1 (border/input). Touch: 48 px high, list rows 48 px.'],
    dont: ['A native <select> look-alike with no keyboard model.', 'A list longer than about 8 rows (add search later).', 'A disabled option with no reason.'] });
  return sel;
}

// ---- Textarea (Forms & selection)
const TEXTAREA_AXES = { State: ['Default', 'Hover', 'Focus', 'Filled', 'Disabled', 'Error'] };
const TEXTAREA_OPTS = { width: 1040, desc: 'Multi-line text, such as the reason a seller reads. Same states and colours as Input. Wrap it in Field for the label, helper, character counter ("{n} / {max}") and error. Min height is three lines of Body/Default plus padding; it grows with the text. Value is empty by default (a placeholder is not a label). Vertical resize only in code, no resize grip in Figma. dir="auto"; paste is never blocked; no maxlength truncation without the visible counter.',
  text: [{ prop: 'Value', node: 'value', def: '' }] };
function textareaVariant(c, p) {
  const border = { Error: 'status/critical/solid', Focus: 'action/primary', Hover: 'text/muted' }[p.State] || 'border/input';
  const filled = p.State === 'Filled';
  body(c, { dir: 'V', w: 280, pad: 'space/2-5', fill: p.State === 'Disabled' ? 'bg/muted' : 'bg/surface', stroke: border, radius: 'radius/control' }, [
    text(filled ? 'Your Halal certificate is not readable. Upload a clear copy of all pages, then contact us to continue.' : '', 'Body/Default', filled ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL' }),
  ]);
  c.minHeight = 80; // three lines of Body/Default (20 px) plus the 10 px padding above and below
  if (p.State === 'Focus') focusRing(c);
}
function textareaBlock(root) {
  const ta = makeSet('Textarea', TEXTAREA_AXES, textareaVariant, TEXTAREA_OPTS);
  componentBlock(root, ta, { title: 'Textarea', summary: 'A longer free-text field (1.8.0): the reason a seller reads in the reject and suspend dialogs. Same states as Input.',
    use: ['Wrap it in Field: label, helper, the counter slot and the error message.'],
    props: ['Value (text)', 'State: Default, Hover, Focus, Filled, Disabled, Error'],
    a11y: ['Label, helper and counter come from Field; the counter is announced politely and not on every keystroke.', 'dir="auto". Paste is never blocked.', 'Error: aria-invalid and aria-describedby; the message is text with an icon.'],
    dont: ['maxlength that cuts text without a visible counter.', 'A placeholder in place of the label.'] });
  return ta;
}

// ---- CheckboxRow (Forms & selection): one permission on the role editor; from 1.10.0 also one reviewer check (P3)
// 1.10.0 "Seller admin" (sellers ux.md section 4): State=Saving (a check saves the moment it is ticked) and Show undo (a link Button "Undo" at the end
// of a recorded check). "Required" is the badge slot with Leading None and Label "Required"; "Recorded by {name} on {dateTime}" is the Description.
const CHECKBOXROW_AXES_180 = { Value: ['Unchecked', 'Checked'], State: ['Default', 'Hover', 'Focus', 'Disabled', 'Read-only'] };
const CHECKBOXROW_AXES = { Value: ['Unchecked', 'Checked'], State: ['Default', 'Hover', 'Focus', 'Disabled', 'Read-only', 'Saving'] };
const CHECKBOXROW_DESC_180 = 'One permission row: a Checkbox, a label, a one-line description and an optional "Protected" Badge (lock icon plus text). The whole row is one <label> (at least 32 px high; 24 px checkbox hit area). Disabled gives the reason in text on the description line (never a tooltip) and stays focusable (aria-disabled). Read-only is for a system or default role where nothing can change: it keeps full contrast, has no hover, and screen readers get "Granted" or "Not granted" as hidden text. Focus puts the Focus/Ring on the row. Group rows per resource in a <fieldset> with a <legend>; the group "Select all in {group}" is a Checkbox with Value=Indeterminate when some rows are on.';
const CHECKBOXROW_DESC = CHECKBOXROW_DESC_180 + ' From 1.10.0 it is also one reviewer check (P3): the check saves the moment it is ticked, State=Saving shows the new value with "Saving…" in place of the description (aria-busy on the row; the icon is drawn still and never spins under reduced motion), then the description reads "Recorded by {name} on {dateTime}". Show undo shows a link Button "Undo" at the end of a recorded check: it sets the check back to not done, and the approval guard counts it missing again. A required check sets the badge to Leading None and Label "Required" (a nested override of the badge slot).';
// 1.8.1: columns are the 2 Values (States as rows), so the set is 1176 wide; with State as columns it was 2960 and stuck out of its documentation row.
const CHECKBOXROW_OPTS = { width: 1280, colAxis: 'Value', desc: CHECKBOXROW_DESC,
  text: [{ prop: 'Label', node: 'label', def: 'View seller accounts' }, { prop: 'Description', node: 'description', def: 'See sellers, their status and their team.' }], bool: [{ prop: 'Show badge', node: 'badge', def: false }, { prop: 'Show undo', node: 'undo', def: false }] };
// The 1.10.0 node: the "Undo" link at the end of the row. It starts hidden, like its property.
function checkboxRowUndo() { const b = inst('Button', { Variant: 'Link', Size: 'Sm', State: 'Default', Label: 'Undo' }, { name: 'undo' }); b.visible = false; return b; }
function checkboxRowVariant(c, p) {
  const dis = p.State === 'Disabled'; const saving = p.State === 'Saving';
  const badge = inst('Badge', { Tone: 'Neutral', Leading: 'Icon', Label: 'Protected', Icon: { icon: 'lock' } }, { name: 'badge' });
  const desc = text(dis ? 'You can’t give a permission you don’t have.' : 'See sellers, their status and their team.', 'Caption/Default', 'text/muted', { name: 'description', sizeH: 'FILL' });
  const lines = [text('View seller accounts', 'Body/Default', dis ? 'text/muted' : 'text/primary', { name: 'label', sizeH: 'FILL' }), desc];
  // Saving: "Saving…" with a still icon takes the description's place; the description stays wired, hidden in this state.
  if (saving) { desc.visible = false; lines.push(frame({ name: 'saving', dir: 'H', gap: 'space/1', align: 'center' }, [icon('refresh-cw', 'icon/muted', 12), text('Saving…', 'Caption/Default', 'text/muted', { name: 'saving-text' })])); }
  body(c, { dir: 'H', w: 560, px: 'space/3', py: 'space/2-5', gap: 'space/3', align: 'start', fill: p.State === 'Hover' ? 'bg/subtle' : null, stroke: 'border/row', sides: ['bottom'] }, [
    inst('Checkbox', { Value: p.Value, State: p.State === 'Focus' ? 'Focus' : (dis ? 'Disabled' : 'Default') }, { name: 'checkbox' }),
    frame({ name: 'content', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, lines),
    badge,
    checkboxRowUndo(),
  ]);
  badge.visible = false;
  if (p.State === 'Focus') focusRing(c);
}
const CHECKBOXROW_PROPS_180 = ['Label, Description (text); Show badge (boolean, the "Protected" Badge)', 'Value: Unchecked, Checked. State: Default, Hover, Focus, Disabled, Read-only'];
const CHECKBOXROW_PROPS = ['Label, Description (text); Show badge (boolean, the "Protected" Badge, or "Required" on a reviewer check); Show undo (boolean, 1.10.0)', 'Value: Unchecked, Checked. State: Default, Hover, Focus, Disabled, Read-only, Saving (1.10.0)'];
const CHECKBOXROW_A11Y_180 = ['The row is one <label>; disabled rows use aria-disabled and stay focusable with the reason tied by aria-describedby.', 'Read-only keeps the checked state readable ("Granted" or "Not granted" as hidden text).', '"Protected" is text plus the lock icon, never colour alone.', 'A group per resource is a <fieldset> with a <legend>.'];
const CHECKBOXROW_A11Y = CHECKBOXROW_A11Y_180.concat(['Saving (1.10.0): aria-busy on the row and "Saving…" in a role="status" region, and the checkbox ignores input until the save ends; "Recorded" is announced once. "Undo" is named "Undo {check}", is not rendered when Show undo is off, announces "Set back to not done." and keeps focus on the row after it.']);
function checkboxRowBlock(root) {
  const cr = makeSet('CheckboxRow', CHECKBOXROW_AXES, checkboxRowVariant, CHECKBOXROW_OPTS);
  componentBlock(root, cr, { title: 'CheckboxRow', summary: 'One permission on the role editor and later multi-select lists (1.8.0); one reviewer check that saves on its own (1.10.0). 2 values by 6 states.',
    use: ['A permission with a name and a one-line description. A permission the user cannot give is shown disabled with its reason, not hidden.', 'Read-only on a system or default role.', 'A reviewer check (P3, 1.10.0): ticking saves it at once (Saving), then "Recorded by {name} on {dateTime}" and "Undo".'],
    props: CHECKBOXROW_PROPS,
    a11y: CHECKBOXROW_A11Y,
    dont: ['A tooltip for the reason.', 'Hiding a permission the user cannot give.'] });
  return cr;
}

// Field's Control slot takes Input, Select and Textarea as preferred swap values (1.8.0). Returns true when it changed something.
function fieldPreferred() {
  const f = S.sets.Field, inp = S.sets.Input, sel = S.sets.Select, ta = S.sets.Textarea;
  if (!f || !f.comp || !f.keys.Control || !inp || !inp.set || !sel || !sel.set || !ta || !ta.set) return false;
  const want = [inp.set, sel.set, ta.set].map(function (n) { return { type: 'COMPONENT_SET', key: n.key }; });
  const have = f.comp.componentPropertyDefinitions[f.keys.Control].preferredValues || [];
  if (want.every(function (w) { return have.some(function (h) { return h.key === w.key; }); })) return false;
  f.comp.editComponentProperty(f.keys.Control, { preferredValues: want });
  return true;
}

// ---- Toast (Status & feedback)
const TOAST_TONE = { Success: ['status/success/track', 'check', 'status/success/fg'], Critical: ['status/critical/border', 'alert-circle', 'status/critical/fg'] };
const TOAST_OPTS = { width: 760, gapX: 40, desc: 'Confirmation after an action ("Role saved…"). It never carries the only copy of a reason or a code. Tone Success (check) or Critical (alert-circle); the icon and the words carry the meaning, the border colour only reinforces it. Width is size/dialog-sm (fills the width in a phone frame). Position: bottom end on desktop, bottom centre on phones above the BottomTabBar and the safe area, and never over the dialog it came from (it appears after the dialog closes). role="status" (Success, polite) or role="alert" (Critical); one live region per page; visible at least 6 seconds, paused on hover and focus, dismissed with Esc or the close button (named "Close"); no slide under prefers-reduced-motion.',
  text: [{ prop: 'Message', node: 'message', def: 'Role saved. Changes apply from each person’s next action.' }, { prop: 'Action', node: 'action', def: 'View role' }], bool: [{ prop: 'Show action', node: 'action', def: false }] };
function toastVariant(c, p) {
  const t = TOAST_TONE[p.Tone];
  body(c, { dir: 'H', w: 'size/dialog-sm', pad: ['space/3', 'space/4', 'space/3', 'space/4'], gap: 'space/3', align: 'start', fill: 'bg/surface', stroke: t[0], radius: 'radius/card', effect: 'Elevation/Floating' }, [
    icon(t[1], t[2], 20),
    text('Role saved. Changes apply from each person’s next action.', 'Body/Default', 'text/primary', { name: 'message', sizeH: 'FILL' }),
    text('View role', 'Body/Strong', 'text/link', { name: 'action' }),
    inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' }),
  ]);
  c.children[0].name = 'icon';
  c.children[2].visible = false;
}
function toastBlock(root) {
  const toast = makeSet('Toast', { Tone: ['Success', 'Critical'] }, toastVariant, TOAST_OPTS);
  componentBlock(root, toast, { title: 'Toast', summary: 'A short confirmation after an action (1.8.0). Message, an optional text action and a close button.',
    use: ['After a dialog closes or a save: "Role saved…", "Invitation sent to {email}.".', 'Critical for a failure that is not tied to a field.'],
    props: ['Message, Action (text); Show action (boolean); Tone: Success, Critical', 'Close is an IconButton named "Close" (identity.common.action.close)'],
    a11y: ['role="status" (Success) or role="alert" (Critical); one live region per page.', 'Visible at least 6 seconds, pauses on hover and focus, closes with Esc.', 'Respects prefers-reduced-motion (no slide).'],
    dont: ['The only copy of a reason or a code in a toast.', 'A toast over the dialog it came from.'] });
  return toast;
}

// ---- DialogBody + Dialog (Status & feedback)
const DIALOGBODY_TEXT = 'The change applies from their next action. They stay signed in.';
function dialogBodyBlock() {
  return makeComponent('DialogBody', function (c) {
    body(c, { dir: 'V', w: 360 }, [text(DIALOGBODY_TEXT, 'Body/Default', 'text/secondary', { name: 'body', sizeH: 'FILL' })]);
  }, { desc: 'The default content of a Dialog: one paragraph in Body/Default. Set Body from the Dialog instance (Content slot), or swap the slot for a form body built from Field, Input, Select and Textarea.', text: [{ prop: 'Body', node: 'body', def: DIALOGBODY_TEXT }] });
}
const DIALOG_AXES = { Size: ['Sm', 'Md'], Tone: ['Default', 'Destructive'], Layout: ['Centred', 'Sheet'] };
function dialogOpts(content) {
  return { width: 1400, gapX: 40, gapY: 40, skip: function (p) { return p.Layout === 'Sheet' && p.Size === 'Md'; },
    desc: 'A modal dialog over a bg/scrim scrim (the scrim belongs to the screen, not to this component). Size Sm is size/dialog-sm (400 px: confirm, change-role and invite dialogs), Md is size/dialog-md (560 px: dialogs with a reason field). Tone=Destructive makes the primary button a Destructive Button and changes nothing else; it opens with focus on Cancel (show the secondary Button in State=Focus). Layout=Sheet is for widths below 480 px: 360 here and full width in screens, top corners rounded, buttons stacked and full width with the primary first, then Cancel, both Size=Touch; it ignores Size, so Sheet by Md does not exist. Title is Heading/H2 and never truncates; Show secondary off is the single-button state (a read-only "View reason" dialog with one Close button). Content is a swap slot that defaults to DialogBody; primary and secondary are exposed Button instances, so their Label is set from the Dialog instance. role="dialog" (alertdialog when Destructive), aria-modal, aria-labelledby the title, aria-describedby the first body text; focus moves in, is trapped and returns to the trigger; Esc closes, except that a dialog holding typed text does not close on a scrim click; the page behind is inert. Max height 90% of the viewport: header and footer stay pinned and the body scrolls. No slide or fade under prefers-reduced-motion.',
    text: [{ prop: 'Title', node: 'title', def: 'Change role for Amira Said' }], bool: [{ prop: 'Show secondary', node: 'secondary', def: true }], swap: [{ prop: 'Content', node: 'content', comp: content }] };
}
function dialogVariant(c, p) {
  const sheet = p.Layout === 'Sheet'; const dest = p.Tone === 'Destructive';
  const w = sheet ? 360 : (p.Size === 'Md' ? 'size/dialog-md' : 'size/dialog-sm');
  const secondary = inst('Button', { Variant: 'Secondary', Size: sheet ? 'Touch' : 'Md', State: 'Default', Label: 'Cancel' }, { name: 'secondary', sizeH: sheet ? 'FILL' : null });
  const primary = inst('Button', { Variant: dest ? 'Destructive' : 'Primary', Size: sheet ? 'Touch' : 'Md', State: 'Default', Label: dest ? 'Deactivate account' : 'Change role' }, { name: 'primary', sizeH: sheet ? 'FILL' : null });
  body(c, { dir: 'V', w: w, fill: 'bg/surface', stroke: 'border/default', clip: true, effect: 'Elevation/Floating' }, [
    frame({ name: 'header', dir: 'H', pad: sheet ? 'space/4' : ['space/5', 'space/5', 'space/2', 'space/5'], gap: 'space/3', align: 'start', sizeH: 'FILL' }, [
      text('Change role for Amira Said', 'Heading/H2', 'text/primary', { name: 'title', sizeH: 'FILL' }),
      inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' }),
    ]),
    frame({ name: 'body', dir: 'V', gap: 'space/4', pad: sheet ? [0, 'space/4', 0, 'space/4'] : [0, 'space/5', 0, 'space/5'], sizeH: 'FILL' }, [inst('DialogBody', {}, { name: 'content', sizeH: 'FILL' })]),
    frame({ name: 'footer', dir: sheet ? 'V' : 'H', justify: sheet ? undefined : 'end', gap: 'space/2', pad: sheet ? 'space/4' : ['space/4', 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, sheet ? [primary, secondary] : [secondary, primary]),
  ]);
  if (sheet) { bindNum(c, 'topLeftRadius', 'radius/card'); bindNum(c, 'topRightRadius', 'radius/card'); c.bottomLeftRadius = 0; c.bottomRightRadius = 0; }
  else radius(c, 'radius/card');
  safe('expose dialog buttons', function () { primary.isExposedInstance = true; secondary.isExposedInstance = true; });
}
function dialogBlock(root) {
  const had = S.sets.DialogBody && S.sets.DialogBody.comp; const db = had || dialogBodyBlock();
  if (!had) {
    const wrap = frame({ name: 'DialogBody', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, db);
    componentBlock(root, wrap, { title: 'DialogBody', summary: 'The default content of a Dialog (1.8.0): one paragraph.', props: ['Body (text)'] });
  }
  if (S.sets.Dialog) return S.sets.Dialog.set;
  const dlg = makeSet('Dialog', DIALOG_AXES, dialogVariant, dialogOpts(db));
  componentBlock(root, dlg, { title: 'Dialog', summary: 'Confirm, change-role, invite and add-seller dialogs, and the phone sheet (1.8.0). 6 variants: Size by Tone by Layout.',
    use: ['Confirming a consequential action: the title names the action and the object, and the primary button repeats the verb.', 'Destructive when the action cannot be undone or signs someone out; it opens with focus on Cancel.', 'Sheet below 480 px: stacked full-width buttons, primary first.'],
    props: ['Title (text); Show secondary (boolean); Content (instance swap, default DialogBody)', 'Primary and secondary are exposed Button instances: set their Label from the Dialog instance', 'Size: Sm or Md. Tone: Default or Destructive. Layout: Centred or Sheet (Sheet has no Md)'],
    a11y: ['role="dialog" (alertdialog when Destructive), aria-modal, aria-labelledby the title, aria-describedby the first body text.', 'Focus moves in, is trapped, and returns to the trigger; Esc closes; the page behind is inert.', 'A dialog holding typed text does not close on a scrim click.', 'The close button is named "Close" (identity.common.action.close).'],
    dont: ['Stacked dialogs, or a Toast over a dialog.', 'A dialog for something that can be a page.', 'A Destructive dialog that opens with focus on the primary button.'] });
  return dlg;
}

// ---- EmptyState (Tables & collections)
const EMPTY_AXES = { Size: ['Page', 'Card', 'Compact'] };
const EMPTY_OPTS = { width: 1500, gapX: 40, desc: 'What a page, a card or a list shows when it has nothing yet. Page is the page\'s H1 (Heading/H1) and fills the content area; Card sits inside a card or a table body (Heading/H2); Compact is a left-aligned row for an empty group inside a list. The icon tile is decorative (aria-hidden); the title is the heading of the region; a non-obvious state has an action (the nested Button is exposed, so set its Label from the EmptyState instance). The empty state replaces the table body; the table header and tabs stay. A failure to load is not an empty state: use InfoBanner Critical with "Try again".',
  text: [{ prop: 'Title', node: 'title', def: 'It’s just you so far' }, { prop: 'Body', node: 'body', def: 'Invite the people who help run your shop. Each person gets their own sign-in.' }], bool: [{ prop: 'Show action', node: 'action', def: true }], swap: [{ prop: 'Icon', node: 'icon', def: 'lock' }] };
function emptyStateVariant(c, p) {
  const page = p.Size === 'Page', compact = p.Size === 'Compact';
  const tile = frame({ name: 'icon-tile', dir: 'H', w: 'size/control-lg', h: 'size/control-lg', align: 'center', justify: 'center', fill: 'bg/muted', radius: 'radius/pill' }, [icon('lock', 'icon/default', 20)]);
  tile.children[0].name = 'icon';
  const titleT = text('It’s just you so far', page ? 'Heading/H1' : 'Heading/H2', 'text/primary', { name: 'title', sizeH: 'FILL' });
  const bodyT = text('Invite the people who help run your shop. Each person gets their own sign-in.', 'Body/Default', 'text/muted', { name: 'body', sizeH: 'FILL' });
  const action = inst('Button', { Variant: page ? 'Primary' : 'Secondary', Size: 'Md', State: 'Default', Label: 'Invite team member' }, { name: 'action' });
  if (compact) body(c, { dir: 'H', w: 560, pad: 'space/4', gap: 'space/3', align: 'center' }, [tile, frame({ name: 'text', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [titleT, bodyT]), action]);
  else body(c, { dir: 'V', w: page ? 640 : 560, pad: page ? 'space/10' : ['space/10', 'space/6', 'space/10', 'space/6'], gap: 'space/3', align: 'center' }, [tile, titleT, bodyT, action]);
  if (!compact) { titleT.textAlignHorizontal = 'CENTER'; bodyT.textAlignHorizontal = 'CENTER'; }
  safe('expose action', function () { action.isExposedInstance = true; });
}
function emptyStateBlock(root) {
  const es = makeSet('EmptyState', EMPTY_AXES, emptyStateVariant, EMPTY_OPTS);
  componentBlock(root, es, { title: 'EmptyState', summary: 'Nothing here yet (1.8.0). Page, Card and Compact, each with an icon, a title, a line of help and an optional action.',
    use: ['Page: a page with no access or no record (its title is the page H1).', 'Card: an empty list inside a card or a table body. Compact: an empty group inside a list ("No custom roles yet").', 'Icon: lock, users, search or check; pick it with the Icon swap.'],
    props: ['Title, Body (text); Show action (boolean); Icon (instance swap)', 'The action is an exposed Button: set its Label from the EmptyState instance', 'Size: Page, Card, Compact'],
    a11y: ['The title is the heading of the region; the icon is aria-hidden.', 'A state the user can act on has an action.'],
    dont: ['A sad illustration.', 'An empty state with no way forward when the user can act.', 'An empty state for a load failure: use InfoBanner Critical with "Try again".'] });
  return es;
}

// ---- TableCell State=Loading (Tables & collections): skeleton shapes in bg/muted, static in Figma (the code shimmers under prefers-reduced-motion: no-preference)
function skBar(w, h) { return rect({ name: 'skeleton', w: w === 'fill' ? 10 : w, h: h, fill: 'bg/muted', radius: 'radius/chip', sizeH: w === 'fill' ? 'FILL' : undefined }); }
// The layers of a Loading cell for each TableCell Type (Header has no Loading variant).
function tcSkeleton(type) {
  if (type === 'Text') return [skBar('fill', 'space/3')];
  if (type === 'Two-line') return [frame({ name: 'lines', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [skBar('fill', 'space/3'), skBar('size/sidebar-collapsed', 'space/2')])];
  if (type === 'Number') return [skBar('space/10', 'space/3')];
  if (type === 'Checkbox') return [rect({ name: 'skeleton', w: 'size/icon', h: 'size/icon', fill: 'bg/muted', radius: 'radius/chip' })];
  return [rect({ name: 'skeleton', w: 'size/icon', h: 'size/icon', fill: 'bg/muted', radius: 'radius/pill' })]; // Actions: a circle
}
const TABLECELL_TYPES_LOADING = ['Text', 'Two-line', 'Number', 'Checkbox', 'Actions'];
const TABLECELL_DESC_170 = 'Build rows from cells: fixed width for short columns, Fill for the main column.';
const TABLECELL_DESC = TABLECELL_DESC_170 + ' Loading shows skeleton bars; build rows from it for 8 skeleton rows (the table header and tabs stay, the region is aria-busy and the skeleton cells are aria-hidden).';
// Update library: add State=Loading to a TableCell set the plugin made, by cloning "Type=T, State=Default" (no combineAsVariants on the existing set).
// Returns the new variants. Existing variants, instances and their properties are not touched; the new column sits right of the existing ones.
function addTableCellLoading() {
  const set = S.sets.TableCell.set; const made = [];
  const todo = TABLECELL_TYPES_LOADING.filter(function (t) { return !set.children.some(function (c) { return c.name === 'Type=' + t + ', State=Loading'; }) && set.children.some(function (c) { return c.name === 'Type=' + t + ', State=Default'; }); });
  if (!todo.length) return made;
  let right = 0; set.children.forEach(function (c) { right = Math.max(right, c.x + c.width); });
  // A new column right of the existing ones; when some Loading variants exist already (a partly updated file) the new ones join their column.
  const there = set.children.filter(function (c) { return /State=Loading/.test(c.name); });
  const x = there.length ? there[0].x : right + 24; let colW = 0;
  todo.forEach(function (t) {
    const src = set.children.filter(function (c) { return c.name === 'Type=' + t + ', State=Default'; })[0];
    const c = src.clone(); c.name = 'Type=' + t + ', State=Loading';
    c.children.slice().forEach(function (k) { k.remove(); });
    tcSkeleton(t).forEach(function (n) { add(c, n); });
    set.appendChild(c);
    c.x = x; c.y = src.y; colW = Math.max(colW, c.width);
    made.push(c); S.counts.variants++;
  });
  set.resize(Math.max(set.width, x + colW + 32), set.height);
  return made;
}

// ==== 35_components_setup.js ====
// ---------------------------------------------------------------- release 1.9.0 "Seller setup" components (sellers ux.md section 4, planned there as 1.3.0)
// FieldStatus (the status line Field shows with Show status), DataRow and FormActionBar. Built by "Build library" on their library pages
// and added to an existing file by "Update library" (see 50_main.js), which also adds the 1.9.0 properties of Field, Input and ChecklistItem.

// ---- FieldStatus (Forms & selection): one line under a field for a check that runs after the person types or saves.
// ux.md names it Field's Status property (None, Checking, Success, Info, Critical); it is a set of its own placed in Field as an exposed
// instance, so Field stays one component: Status None is Show status off.
const FIELD_STATUS = {
  Checking: ['refresh-cw', 'icon/muted', 'text/secondary'],
  Success: ['check', 'status/success/fg', 'status/success/fg'],
  Info: ['info', 'status/info/fg', 'text/secondary'],
  Critical: ['alert-circle', 'status/critical/fg', 'status/critical/fg'],
};
const FIELD_STATUS_OPTS = { width: 1040, desc: 'The status line under a field (1.9.0): Checking while a check runs (role="status"; the icon is drawn still and never spins under reduced motion), Success, Info and Critical, each an icon and words, never colour alone. Field shows it with Show status (exposed as "status"); it reads the business-number result (S4) and the shop web address check (S5, D7). Text comes from the API as a translation key; never a server message.',
  text: [{ prop: 'Text', node: 'status-text', def: 'Checking…' }] };
function fieldStatusVariant(c, p) {
  const t = FIELD_STATUS[p.Tone];
  body(c, { dir: 'H', w: 360, gap: 'space/1-5', align: 'start' }, [
    frame({ name: 'icon-box', dir: 'H', pad: [1, 0, 0, 0] }, [icon(t[0], t[1], 16)]),
    text('Checking…', 'Body/Small', t[2], { name: 'status-text', sizeH: 'FILL' }),
  ]);
}
const FIELD_STATUS_AXES = { Tone: Object.keys(FIELD_STATUS) };
function fieldStatusBlock(root) {
  const set = makeSet('FieldStatus', FIELD_STATUS_AXES, fieldStatusVariant, FIELD_STATUS_OPTS);
  componentBlock(root, set, { title: 'FieldStatus', summary: 'The result line of a check on one field (1.9.0). Field places it under the control with Show status.',
    use: ['Business number: Checking, Matched (Success), Could not be checked (Info), Not matched (Critical).', 'Shop web address: Checking, Available (Success), Not available (Critical).', 'A format error stays the Field error, not a status: a field shows its error or its status, never both.'],
    props: ['Tone: Checking, Success, Info, Critical', 'Text (text)'],
    a11y: ['Checking is a role="status" region; the result replaces it in the same region.', 'Icon and words for every tone, never colour alone.'],
    dont: ['A spinner that keeps turning under reduced motion.', 'Words such as "verified" or "already registered".'] });
  return set;
}
// The slot Field holds (1.9.0): hidden until Show status is on.
function fieldStatusSlot() { const i = inst('FieldStatus', { Tone: 'Checking' }, { name: 'status', sizeH: 'FILL' }); i.visible = false; return i; }

// ---- DataRow (Review & detail): a label and a read-only value, or two values to compare. S6 summary, S7, P2 and P3.
// Width=Narrow (below 760 px) puts the label above the value, so a phone row keeps the value's width.
const DATAROW_AXES = { Layout: ['Single', 'Compare'], Width: ['Wide', 'Narrow'], State: ['Default', 'Missing', 'Blocked', 'Changed'] };
// Missing and Blocked belong to the summary before a submission (S6), so a Compare row has neither. Compare has no Narrow layout yet:
// its screens (S7, P2, P3) wait for the mobile navigation (D16) on phones.
const DATAROW_SKIP = function (p) { return p.Layout === 'Compare' && (p.State === 'Missing' || p.State === 'Blocked' || p.Width === 'Narrow'); };
const DATAROW_KEYS = ['Label', 'Value', 'Compare value', 'Value label', 'Compare label', 'Note', 'Show note', 'Show flag', 'Show action', 'Show second action'];
const DATAROW_OPTS = { width: 1440, colAxis: 'Layout', skip: DATAROW_SKIP, // Layout in 2 columns, Width and State in rows: 1368 px wide, so the block fits the page
  desc: 'A label and a read-only value (1.9.0). Layout=Compare shows two values side by side with their own labels (Current and Requested for a change request; Submitted and Register for an admin). Width=Narrow, below 760 px, puts the label above the value. State=Missing replaces the value with "Missing" (an empty required value); State=Blocked keeps the value and adds "Blocked" (outside the service area, time zone not found, a definite register negative), with the reason in the note and "Contact us" as the second action. State=Changed adds the Changed badge. Show note adds a line under the value; Show flag adds a Badge (exposed as "flag": Waiting for review, Matches, Differs); Show action and Show second action show link Buttons (exposed as "action" and "second-action": Edit, Request a change, Contact us). Values are plain text shown with dir="auto"; never a register value to a seller.',
  text: [{ prop: 'Label', node: 'label', def: 'Store name' }, { prop: 'Value', node: 'value', def: 'Kuraby Fresh' }, { prop: 'Compare value', node: 'compare-value', def: 'Kuraby Fresh Grocers' },
    { prop: 'Value label', node: 'value-label', def: 'Current' }, { prop: 'Compare label', node: 'compare-label', def: 'Requested' }, { prop: 'Note', node: 'note', def: 'We’re not in your area yet.' }],
  bool: [{ prop: 'Show note', node: 'note', def: false }, { prop: 'Show flag', node: 'flag', def: false }, { prop: 'Show action', node: 'action', def: true }, { prop: 'Show second action', node: 'second-action', def: false }] };
function rowMarker(ic, token, word) { return frame({ name: 'marker', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon(ic, token, 16), text(word, 'Body/Small Strong', token, { name: 'marker-text' })]); }
function dataRowVariant(c, p) {
  const narrow = p.Width === 'Narrow';
  const value = function (node, str, strong) { return text(str, strong ? 'Body/Strong' : 'Body/Default', 'text/primary', { name: node, sizeH: 'FILL' }); };
  const note = text('We’re not in your area yet.', 'Body/Small', 'text/secondary', { name: 'note', sizeH: 'FILL' }); note.visible = false;
  let values;
  if (p.Layout === 'Compare') {
    values = frame({ name: 'values', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [
      frame({ name: 'pair', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [
        frame({ name: 'current', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Current', 'Caption/Default', 'text/muted', { name: 'value-label' }), value('value', 'Kuraby Fresh')]),
        frame({ name: 'requested', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Requested', 'Caption/Default', 'text/muted', { name: 'compare-label' }), value('compare-value', 'Kuraby Fresh Grocers', true)]),
      ]),
      note,
    ]);
  } else {
    const kids = [];
    if (p.State === 'Missing') kids.push(rowMarker('alert-circle', 'status/attention/fg', 'Missing'));
    else kids.push(value('value', 'Kuraby Fresh'));
    if (p.State === 'Blocked') kids.push(rowMarker('alert-triangle', 'status/attention/fg', 'Blocked'));
    kids.push(note);
    values = frame({ name: 'values', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, kids);
  }
  const flag = inst('Badge', { Tone: 'Neutral', Leading: 'None', Label: 'Waiting for review' }, { name: 'flag' }); flag.visible = false;
  const action = inst('Button', { Variant: 'Link', Size: 'Sm', State: 'Default', Label: 'Edit' }, { name: 'action' });
  const second = inst('Button', { Variant: 'Link', Size: 'Sm', State: 'Default', Label: 'Contact us' }, { name: 'second-action' }); second.visible = false;
  const changed = p.State === 'Changed' ? inst('Badge', { Tone: 'Info', Leading: 'None', Label: 'Changed' }, { name: 'changed' }) : null;
  const actions = frame({ name: 'actions', dir: 'H', gap: 'space/3', align: 'center' }, [action, second]);
  const label = text('Store name', 'Body/Small', 'text/muted', narrow ? { name: 'label', sizeH: 'FILL' } : { name: 'label', w: 168 });
  const box = { pad: ['space/3', 'space/4', 'space/3', 'space/4'], fill: 'bg/surface', stroke: 'border/row', sides: ['bottom'] };
  if (narrow) body(c, Object.assign({ dir: 'V', w: 360, gap: 'space/1' }, box), [label, values, frame({ name: 'meta', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/1' }, [changed, flag, actions])]);
  else body(c, Object.assign({ dir: 'H', w: 'size/form-max', gap: 'space/4', align: 'start' }, box), [label, values, changed, flag, actions]);
  safe('expose flag and actions', function () { flag.isExposedInstance = true; action.isExposedInstance = true; second.isExposedInstance = true; });
}
function dataRowBlock(root) {
  const set = makeSet('DataRow', DATAROW_AXES, dataRowVariant, DATAROW_OPTS);
  componentBlock(root, set, { title: 'DataRow', summary: 'Read-only values with an optional flag and actions (1.9.0): the summary before a seller submits (S6), the store profile (S7), the seller page and the review page (P2, P3).',
    use: ['Layout=Single for one value; Compare for current against requested, or submitted against the register (admins only).', 'Width=Narrow below 760 px: the label goes above the value.', 'Missing for an empty required value, Blocked for a value that stops the submission (its reason in the note, "Contact us" as the second action), Changed for a value changed since the last submission.', 'Stack rows inside a Card; the last row keeps its border (the Card clips it).'],
    props: ['Layout · Width · State (Compare has Wide only, with Default and Changed)', 'Label, Value, Compare value, Value label, Compare label, Note (text)', 'Show note, Show flag, Show action, Show second action (boolean); flag, action and second-action are exposed instances (Badge, link Buttons)'],
    a11y: ['A row is a <div> pair in a description list (<dl>: <dt> label, <dd> value).', '"Missing" and "Blocked" are words with an icon, never colour alone. Blocked is Attention, like the outside-area banner; a definite register negative keeps its Critical line on S4.', 'The actions are link Buttons with a focus state and 48 px targets in Touch density; each names its row: "Edit store name".'],
    dont: ['A register value shown to a seller.', 'Truncating a value: it wraps.'] });
  return set;
}

// ---- FormActionBar (Forms & selection): the save bar at the end of a form. Sticky at the bottom of the screen below 760 px.
const FAB_AXES = { Layout: ['Inline', 'Sticky'], State: ['Clean', 'Dirty', 'Saving', 'Error'] };
const FAB_STATUS = { Clean: ['check', 'status/success/fg', 'Saved', 'text/secondary'], Dirty: ['pencil', 'icon/muted', 'Unsaved changes', 'text/secondary'], Saving: ['refresh-cw', 'icon/muted', 'Saving…', 'text/muted'], Error: ['alert-circle', 'status/critical/fg', 'Not saved', 'status/critical/fg'] };
const FAB_OPTS = { width: 1440, colAxis: 'Layout', // Inline and Sticky in 2 columns, State in rows
  desc: 'The save bar of a form (1.9.0): a status text, a secondary action and the primary action. State: Clean (Saved), Dirty (Unsaved changes), Saving (the primary shows State=Loading at the same width), Error (Not saved; the error summary above the form says why and takes focus). Layout=Inline sits at the end of the form column; Layout=Sticky is pinned to the bottom of the screen below 760 px, with full-width touch buttons. The buttons are exposed ("primary", "secondary") so their labels are set from the bar; Show status and Show secondary hide the parts a form does not need. ID-UX B3 adopts it.',
  bool: [{ prop: 'Show status', node: 'status', def: true }, { prop: 'Show secondary', node: 'secondary', def: true }] };
function formActionBarVariant(c, p) {
  const st = FAB_STATUS[p.State]; const sticky = p.Layout === 'Sticky'; const size = sticky ? 'Touch' : 'Md';
  const status = frame({ name: 'status', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon(st[0], st[1], 16), text(st[2], 'Body/Small Strong', st[3], { name: 'status-text' })]);
  const secondary = inst('Button', { Variant: 'Secondary', Size: size, State: 'Default', Label: 'Back to checklist' }, { name: 'secondary', sizeH: sticky ? 'FILL' : null });
  const primary = inst('Button', { Variant: 'Primary', Size: size, State: p.State === 'Saving' ? 'Loading' : 'Default', Label: 'Save and continue' }, { name: 'primary', sizeH: sticky ? 'FILL' : null });
  // one order in both layouts (status, secondary, primary), so the visual order is the DOM and focus order
  if (sticky) body(c, { dir: 'V', w: 360, pad: 'space/4', gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', sides: ['top'] }, [status, secondary, primary]);
  else body(c, { dir: 'H', w: 'size/form-max', pad: ['space/4', 0, 0, 0], gap: 'space/3', align: 'center', stroke: 'border/row', sides: ['top'] }, [status, frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), secondary, primary]);
  safe('expose buttons', function () { secondary.isExposedInstance = true; primary.isExposedInstance = true; });
}
function formActionBarBlock(root) {
  const set = makeSet('FormActionBar', FAB_AXES, formActionBarVariant, FAB_OPTS);
  componentBlock(root, set, { title: 'FormActionBar', summary: 'One save bar for forms in both panels (1.9.0): the seller setup steps (Save and continue, Back to checklist), the store profile cards and later every settings form.',
    use: ['One bar per form or card group; one primary action.', 'Layout=Sticky below 760 px, so the primary action stays in reach while the form scrolls.', 'The status text is a role="status" region; Error goes with the error summary at the top of the form.'],
    props: ['Layout: Inline, Sticky', 'State: Clean, Dirty, Saving, Error', 'Show status, Show secondary (boolean); primary and secondary are exposed Buttons'],
    a11y: ['DOM, focus and visual order are the same in both layouts: status, secondary, primary (the primary is last, nearest the thumb on a phone).', 'Saving: the primary shows Loading at the same width with aria-busy="true", not disabled, so focus stays on it; focus stays on the primary after a save.', 'A disabled primary stays focusable and names its reason with aria-describedby; the reason is text beside it.', 'Show status is off until the form has been saved once: a form never saved shows no "Saved".', 'Sticky: the bar never covers the focused field (scroll-padding in code).'],
    dont: ['Two primary actions.', 'A status shown by colour alone.'] });
  return set;
}

// ---- Update library (1.9.0): the new properties of Input, ChecklistItem and Field, added in place to the plugin's own components.
// A first, read-only pass decides what each one needs and reports a component whose layers were changed by hand; each step's run()
// then edits only that component and returns the lines for the report. Nodes are added hidden, as their boolean's default is false.
function propertySteps190(own) {
  const steps = [];
  const named = function (v, name, type) { return v.children.filter(function (n) { return n.name === name && (!type || n.type === type); })[0]; };
  // Input: the prefix text after the leading icon in each Type=Text variant.
  const inp = S.sets.Input;
  if (!own('Input')) log('ℹ skipped Input properties Show prefix and Prefix: the Input set is not the plugin\'s');
  else {
    const textVars = inp.set.children.filter(function (v) { return v.variantProperties.Type === 'Text'; });
    const lacking = textVars.filter(function (v) { return !named(v, 'prefix'); });
    const odd = lacking.filter(function (v) { return !v.children[0] || v.children[0].name !== 'icon-leading' || !named(v, 'value', 'TEXT'); });
    if (odd.length) log('ℹ skipped the Input prefix in ' + odd.map(function (v) { return v.name; }).join('; ') + ': its layers were changed by hand');
    const todo = lacking.filter(function (v) { return odd.indexOf(v) < 0; });
    const props = !inp.keys.Prefix || !inp.keys['Show prefix']; const desc = inp.set.description === INPUT_DESC_170;
    if (props || todo.length || desc) steps.push({ node: inp.set, label: 'Input prefix', run: function () {
      const out = [];
      if (props) {
        if (!inp.keys.Prefix) inp.keys.Prefix = inp.set.addComponentProperty('Prefix', 'TEXT', INPUT_PREFIX);
        if (!inp.keys['Show prefix']) inp.keys['Show prefix'] = inp.set.addComponentProperty('Show prefix', 'BOOLEAN', false);
        out.push('Input properties Show prefix and Prefix');
      }
      todo.forEach(function (v) { v.insertChild(1, inputPrefix()); });
      textVars.forEach(function (v) { wireVariant(v, inp.keys, { text: [{ prop: 'Prefix', node: 'prefix' }], bool: [{ prop: 'Show prefix', node: 'prefix' }] }); });
      if (todo.length) out.push('Input prefix layer (' + todo.length + ' Type=Text variants)');
      if (desc) { inp.set.description = INPUT_OPTS.desc; out.push('update Input description'); }
      return out;
    } });
  }
  // ChecklistItem: the detail line after By, the chevron at the end of the row.
  const ck = S.sets.ChecklistItem;
  if (!own('ChecklistItem')) log('ℹ skipped ChecklistItem properties Show detail, Detail and Show chevron: the ChecklistItem set is not the plugin\'s');
  else {
    const content = function (v) { return named(v, 'content', 'FRAME'); };
    const lacking = ck.set.children.filter(function (v) { const c = content(v); return !c || !named(c, 'detail') || !named(v, 'chevron'); });
    const odd = lacking.filter(function (v) { const c = content(v); return v.layoutMode !== 'HORIZONTAL' || !c || !named(c, 'by', 'TEXT'); });
    if (odd.length) log('ℹ skipped the ChecklistItem detail and chevron in ' + odd.map(function (v) { return v.name; }).join('; ') + ': its layers were changed by hand');
    const todo = lacking.filter(function (v) { return odd.indexOf(v) < 0; });
    const props = !ck.keys.Detail || !ck.keys['Show detail'] || !ck.keys['Show chevron']; const desc = ck.set.description === CHECKLIST_DESC_170;
    if (props || todo.length || desc) steps.push({ node: ck.set, label: 'ChecklistItem detail', run: function () {
      const out = [];
      if (props) {
        if (!ck.keys.Detail) ck.keys.Detail = ck.set.addComponentProperty('Detail', 'TEXT', '2 fields left');
        if (!ck.keys['Show detail']) ck.keys['Show detail'] = ck.set.addComponentProperty('Show detail', 'BOOLEAN', false);
        if (!ck.keys['Show chevron']) ck.keys['Show chevron'] = ck.set.addComponentProperty('Show chevron', 'BOOLEAN', false);
        out.push('ChecklistItem properties Show detail, Detail and Show chevron');
      }
      todo.forEach(function (v) {
        const c = content(v);
        if (!named(c, 'detail')) c.insertChild(c.children.indexOf(named(c, 'by', 'TEXT')) + 1, checklistDetail());
        if (!named(v, 'chevron')) v.appendChild(checklistChevron());
      });
      ck.set.children.forEach(function (v) { wireVariant(v, ck.keys, { text: [{ prop: 'Detail', node: 'detail' }], bool: [{ prop: 'Show detail', node: 'detail' }, { prop: 'Show chevron', node: 'chevron' }] }); });
      if (todo.length) out.push('ChecklistItem detail line and chevron (' + todo.length + ' variants)');
      if (desc) { ck.set.description = CHECKLIST_OPTS.desc; out.push('update ChecklistItem description'); }
      return out;
    } });
  }
  // Field: the exposed FieldStatus line after the control (it needs the plugin's FieldStatus, made earlier in this run or before).
  const fr = S.sets.Field;
  if (fr && fr.comp) {
    const f = fr.comp; const has = named(f, 'status', 'INSTANCE'); const ctl = named(f, 'control', 'INSTANCE');
    if (!own('Field')) log('ℹ skipped Field property Show status: the Field component is not the plugin\'s');
    else if (!own('FieldStatus')) log('ℹ skipped Field property Show status: it needs the plugin\'s FieldStatus');
    else if (!has && (!ctl || f.layoutMode !== 'VERTICAL')) log('ℹ skipped Field property Show status: its layers were changed by hand');
    else {
      const props = !fr.keys['Show status']; const desc = f.description === FIELD_DESC_180;
      if (!has || props || desc) steps.push({ node: f, label: 'Field status', run: function () {
        const out = [];
        let st = has;
        if (!st) { st = fieldStatusSlot(); add(f, st); f.insertChild(f.children.indexOf(ctl) + 1, st); safe('expose Field status', function () { st.isExposedInstance = true; }); out.push('Field status line (an exposed FieldStatus)'); }
        if (props) { fr.keys['Show status'] = f.addComponentProperty('Show status', 'BOOLEAN', false); out.push('Field property Show status'); }
        st.componentPropertyReferences = Object.assign({}, st.componentPropertyReferences || {}, { visible: fr.keys['Show status'] });
        if (desc) { f.description = FIELD_DESC; out.push('update Field description'); }
        return out;
      } });
    }
  }
  // SegmentedControl: the radio-group use in its description and its Usage panel (Accessibility).
  const sr = S.sets.SegmentedControl; const sc = sr && sr.comp;
  if (sc && !own('SegmentedControl')) log('ℹ skipped SegmentedControl radio-group note: the component is not the plugin\'s');
  else if (sc) {
    const row = sc.parent && sc.parent.parent;
    const panel = row && row.type === 'FRAME' && row.name === 'Component + usage' ? named(row, 'Usage', 'FRAME') : null;
    const acc = panel && named(panel, 'Accessibility', 'FRAME'); const list = acc && named(acc, 'List', 'FRAME');
    const items = list ? list.children : [];
    const first = items.length && items[0].children[1];
    const note = items.length === 1 && first && first.type === 'TEXT' && first.characters === SEG_A11Y_170[0];
    const done = items.length === SEG_A11Y.length && items.every(function (it, i) { return it.children[1] && it.children[1].characters === SEG_A11Y[i]; });
    if (!note && !done) log('ℹ skipped SegmentedControl radio-group note in its Usage panel: the panel was changed by hand');
    const desc = sc.description === SEG_DESC_170;
    if (note || desc) steps.push({ node: sc, label: 'SegmentedControl radio group', run: function () {
      const out = [];
      if (note) {
        first.characters = SEG_A11Y[0]; if (first.name === SEG_A11Y_170[0].slice(0, 40)) first.name = SEG_A11Y[0].slice(0, 40); // text() names a layer by its first 40 characters
        const tmp = bullets(SEG_A11Y.slice(1), 312); tmp.children.slice().forEach(function (it) { list.appendChild(it); }); tmp.remove();
        out.push('SegmentedControl Usage: radio-group semantics');
      }
      if (desc) { sc.description = SEG_DESC; out.push('update SegmentedControl description'); }
      return out;
    } });
  }
  return steps;
}
// The 1.9.0 properties the Seller setup templates set; a file that lacks one gets no Seller setup templates.
function setupLacks() {
  const want = { Input: ['Prefix', 'Show prefix'], ChecklistItem: ['Detail', 'Show detail', 'Show chevron'], Field: ['Show status'] };
  const out = [];
  Object.keys(want).forEach(function (n) { const r = S.sets[n]; want[n].forEach(function (k) { if (!r || !r.keys[k]) out.push(n + ' ' + k); }); });
  // and the layers those properties show: a variant changed by hand that did not get them holds the templates back too
  const has = function (node, name) { return node.children.some(function (k) { return k.name === name; }); };
  const inp = S.sets.Input, ck = S.sets.ChecklistItem, fr = S.sets.Field;
  const noPrefix = inp && inp.set ? inp.set.children.filter(function (v) { return v.variantProperties.Type === 'Text' && !has(v, 'prefix'); }).length : 0;
  if (noPrefix) out.push('Input prefix layer (' + noPrefix + ' Type=Text variants without it)');
  const noDetail = ck && ck.set ? ck.set.children.filter(function (v) { const c = v.children.filter(function (k) { return k.name === 'content'; })[0]; return !c || !has(c, 'detail') || !has(v, 'chevron'); }).length : 0;
  if (noDetail) out.push('ChecklistItem detail and chevron (' + noDetail + ' variants without them)');
  if (fr && fr.comp && !fr.comp.children.some(function (k) { return k.name === 'status' && k.type === 'INSTANCE'; })) out.push('Field status line');
  return out;
}

// ==== 36_components_admin.js ====
// ---------------------------------------------------------------- release 1.10.0 "Seller admin" components (sellers ux.md section 4, planned there as 1.4.0)
// SettingRow is new; CheckboxRow gains State=Saving and Show undo (34_components_panel.js). Build library makes both on Forms & selection;
// Update library adds SettingRow and changes the plugin's own CheckboxRow in place (propertySteps1100, below; see 50_main.js step 2g).

// ---- SettingRow (Forms & selection): one setting that saves on its own. C1 Admin-only settings on the seller page (P2), Seller settings (P4)
// and every later setting (SEL-15). The control is a swap slot: a Switch, or a SegmentedControl for two or three answers.
const SETTINGROW_AXES = { State: ['Default', 'Saving', 'Locked', 'Error'] };
// [icon, icon colour, sample message, text colour]: Locked gives the reason, Error says the save failed. The Error text has no copy key yet (sample).
const SETTINGROW_MSG = { Locked: ['lock', 'icon/muted', 'Your role can view these settings but not change them.', 'text/secondary'], Error: ['alert-circle', 'status/critical/fg', 'We couldn’t save this change. Try again.', 'status/critical/fg'] };
// Message is one text property for Locked and Error, so its default names both uses; each instance sets the reason or the failure text.
const SETTINGROW_MSG_DEF = 'Why it’s locked, or that the save failed.';
const SETTINGROW_KEYS = ['Label', 'Description', 'Meta', 'Message', 'Show meta', 'Control'];
function settingRowOpts(control) {
  return { width: 1368, desc: 'One setting that saves on its own (1.10.0): a label, a description, the control and the line "Changed by {name} on {date}" (Meta, read from the setting itself; Show meta off before the first change). Control is a swap slot (default a Switch, preferred Switch and SegmentedControl) and an exposed instance, so its value and segment labels are set from the row. State: Default; Saving while the request runs (the control shows the new value, "Saving…" with a still icon, aria-busy); Locked when the role cannot change it or the feature is not there yet (the control is drawn at 40% and stays focusable with aria-disabled; Message gives the reason in text, never a tooltip); Error when the save failed (the control shows the old value again; Message says so). A change with a consequence goes through a confirm dialog first (D3). A list that follows a choice, such as the CheckboxRow list for "Only selected types", sits under the row, not inside it. Width size/form-max; fill the card in screens.',
    text: [{ prop: 'Label', node: 'label', def: 'Require approval for new sellers' }, { prop: 'Description', node: 'description', def: 'New sign-ups wait for a person to approve them.' }, { prop: 'Meta', node: 'meta', def: 'Changed by Layla Haddad on 6 Oct 2026' }, { prop: 'Message', node: 'message-text', def: SETTINGROW_MSG_DEF }],
    bool: [{ prop: 'Show meta', node: 'meta', def: true }], swap: [{ prop: 'Control', node: 'control', comp: control }] };
}
function settingRowVariant(c, p) {
  const m = SETTINGROW_MSG[p.State];
  const lines = [text('Require approval for new sellers', 'Body/Strong', 'text/primary', { name: 'label', sizeH: 'FILL' }), text('New sign-ups wait for a person to approve them.', 'Body/Small', 'text/secondary', { name: 'description', sizeH: 'FILL' })];
  if (p.State === 'Saving') lines.push(frame({ name: 'saving', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon('refresh-cw', 'icon/muted', 14), text('Saving…', 'Body/Small', 'text/muted', { name: 'saving-text' })]));
  if (m) lines.push(frame({ name: 'message', dir: 'H', gap: 'space/1-5', align: 'start', sizeH: 'FILL' }, [frame({ name: 'icon-box', dir: 'H', pad: [1, 0, 0, 0] }, [icon(m[0], m[1], 14)]), text(m[2], 'Body/Small', m[3], { name: 'message-text', sizeH: 'FILL' })]));
  lines.push(text('Changed by Layla Haddad on 6 Oct 2026', 'Caption/Default', 'text/muted', { name: 'meta', sizeH: 'FILL' }));
  const control = inst('Switch', { On: 'True', Size: 'Md' }, { name: 'control' });
  if (p.State === 'Locked') control.opacity = 0.4;
  body(c, { dir: 'H', w: 'size/form-max', pad: ['space/4', 'space/5', 'space/4', 'space/5'], gap: 'space/4', align: 'start', stroke: 'border/row', sides: ['bottom'] }, [
    frame({ name: 'content', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, lines),
    frame({ name: 'control-box', dir: 'H', pad: [2, 0, 0, 0] }, [control]),
  ]);
  safe('expose control', function () { control.isExposedInstance = true; });
}
// Switch and SegmentedControl are the preferred values of the Control slot.
function settingRowPreferred(set, key) {
  const sw = S.sets.Switch, seg = S.sets.SegmentedControl;
  const want = [];
  if (sw && sw.set) want.push({ type: 'COMPONENT_SET', key: sw.set.key });
  if (seg && seg.comp) want.push({ type: 'COMPONENT', key: seg.comp.key });
  if (want.length) safe('SettingRow preferred controls', function () { set.editComponentProperty(key, { preferredValues: want }); });
}
function settingRowBlock(root) {
  const control = S.sets.Switch.set.children.filter(function (v) { return v.name === 'On=True, Size=Md'; })[0];
  const set = makeSet('SettingRow', SETTINGROW_AXES, settingRowVariant, settingRowOpts(control));
  settingRowPreferred(set, S.sets.SettingRow.keys.Control);
  componentBlock(root, set, { title: 'SettingRow', summary: 'One setting that saves on its own (1.10.0): Admin-only settings on the seller page (C1), Seller settings (P4) and every later setting.',
    use: ['One setting per row inside a Card; each row saves on its own, after a confirm dialog when the change has a consequence.', 'Control: a Switch for on or off; a SegmentedControl for two or three answers (All types or Only selected types). A list that follows the choice sits under the row.', 'Saving while the request runs; Locked when the role cannot change it or the feature is not there yet; Error when the save failed (the control shows the old value again). Message is one text for Locked and Error, so each use sets it: the reason, or the failure text.', 'Meta is "Changed by {name} on {date}", from the setting itself.'],
    props: ['Label, Description, Meta, Message (text); Show meta (boolean)', 'Control (instance swap, Switch or SegmentedControl), exposed so its value is set from the row', 'State: Default, Saving, Locked, Error'],
    a11y: ['The label names the control (role="switch", or a radio group for a SegmentedControl); the description and the meta line are tied with aria-describedby.', 'Locked: the control is aria-disabled and stays focusable; the reason is text beside it, tied with aria-describedby, never a tooltip. The dimmed control is the disabled look of this library (40% opacity).', 'Saving: aria-busy on the row and "Saving…" in a role="status" region. Error is announced once and keeps focus on the control.', 'Every state is words with an icon, never colour alone.'],
    dont: ['A separate Save button for one setting.', 'Hiding a setting the role cannot change.'] });
  return set;
}

// ---- Update library (1.10.0): CheckboxRow State=Saving and Show undo, added in place to the plugin's own set.
// A first, read-only pass decides what the set needs and reports variants or a Usage panel changed by hand; run() then edits only the set
// and its documentation block. The undo link is added hidden at the end of each 1.8.0 variant, as Show undo defaults to off.
const CHECKBOXROW_USE_180 = ['A permission with a name and a one-line description. A permission the user cannot give is shown disabled with its reason, not hidden.', 'Read-only on a system or default role.'];
const CHECKBOXROW_SUMMARY_180 = 'One permission on the role editor and later multi-select lists (1.8.0). 2 values by 5 states.';
function checkboxRowDocs(set) {
  const named = function (n, name) { return n && n.children ? n.children.filter(function (k) { return k.name === name; })[0] : null; };
  const row = set.parent && set.parent.type === 'FRAME' && set.parent.name === 'Component + usage' ? set.parent : null;
  const panel = named(row, 'Usage'); const sec = row && row.parent;
  const head = named(sec, 'Section header'); const summary = head && head.children.filter(function (k) { return k.type === 'TEXT'; })[1];
  const list = function (g) { const l = named(named(panel, g), 'List'); return l ? l.children : null; };
  const texts = function (items) { return items ? items.map(function (it) { return it.children[1] && it.children[1].type === 'TEXT' ? it.children[1].characters : null; }) : null; };
  return { summary: summary, use: list('When to use'), props: list('Properties'), a11y: list('Accessibility'), useList: named(named(panel, 'When to use'), 'List'), a11yList: named(named(panel, 'Accessibility'), 'List'), texts: texts };
}
function propertySteps1100(own) {
  const steps = [];
  const rec = S.sets.CheckboxRow;
  if (!rec || !rec.set) return steps;
  if (!own('CheckboxRow')) { log('ℹ skipped CheckboxRow State=Saving and Show undo: the CheckboxRow set is not the plugin\'s'); return steps; }
  const deps = ['Button', 'Badge', 'Checkbox'].filter(function (n) { return !own(n); });
  if (deps.length) { log('ℹ skipped CheckboxRow State=Saving and Show undo: they need the plugin\'s ' + deps.join(', ')); return steps; }
  const set = rec.set;
  const lacking = set.children.filter(function (v) { return !v.children.some(function (k) { return k.name === 'undo'; }); });
  const odd = lacking.filter(function (v) { return v.layoutMode !== 'HORIZONTAL' || v.children.map(function (k) { return k.name; }).join() !== 'checkbox,content,badge'; });
  if (odd.length) log('ℹ skipped the CheckboxRow undo action in ' + odd.map(function (v) { return v.name; }).join('; ') + ': its layers were changed by hand');
  const todo = lacking.filter(function (v) { return odd.indexOf(v) < 0; });
  const have = {}; set.children.forEach(function (v) { have[variantName(sortedProps(v.variantProperties, rec.axes))] = 1; });
  const saving = combos(CHECKBOXROW_AXES).filter(function (p) { return p.State === 'Saving' && !have[variantName(sortedProps(p, rec.axes))]; });
  const prop = !rec.keys['Show undo']; const desc = set.description === CHECKBOXROW_DESC_180;
  // the documentation block: replaced or extended only when it still holds the 1.8.0 text
  const d = checkboxRowDocs(set); const t = d.texts;
  const same = function (a, b) { return !!a && a.length === b.length && a.every(function (x, i) { return x === b[i]; }); };
  const old = d.summary && d.summary.characters === CHECKBOXROW_SUMMARY_180 && same(t(d.use), CHECKBOXROW_USE_180) && same(t(d.props), CHECKBOXROW_PROPS_180) && same(t(d.a11y), CHECKBOXROW_A11Y_180);
  const done = d.summary && d.summary.characters !== CHECKBOXROW_SUMMARY_180 && same(t(d.props), CHECKBOXROW_PROPS) && same(t(d.a11y), CHECKBOXROW_A11Y);
  if (!old && !done) log('ℹ skipped CheckboxRow Usage: Saving and Show undo: the documentation block was changed by hand');
  if (prop || todo.length || saving.length || desc || old) steps.push({ node: set, label: 'CheckboxRow Saving and undo', run: function () {
    const out = [];
    if (prop) { rec.keys['Show undo'] = set.addComponentProperty('Show undo', 'BOOLEAN', false); out.push('CheckboxRow property Show undo'); }
    todo.forEach(function (v) { add(v, checkboxRowUndo()); });
    set.children.forEach(function (v) { wireVariant(v, rec.keys, { bool: [{ prop: 'Show undo', node: 'undo' }] }); });
    if (todo.length) out.push('CheckboxRow undo action (' + todo.length + ' variants)');
    const made = saving.length ? addVariants(rec, saving, checkboxRowVariant, CHECKBOXROW_OPTS, 'Value') : [];
    if (made.length) out.push('variants added to CheckboxRow (' + made.length + '): State=Saving');
    if (desc) { set.description = CHECKBOXROW_DESC; out.push('update CheckboxRow description'); }
    if (old) {
      const swapText = function (node, from, to) { node.characters = to; if (node.name === from.slice(0, 40)) node.name = to.slice(0, 40); }; // text() names a layer by its first 40 characters
      swapText(d.summary, CHECKBOXROW_SUMMARY_180, 'One permission on the role editor and later multi-select lists (1.8.0); one reviewer check that saves on its own (1.10.0). 2 values by 6 states.');
      d.props.forEach(function (it, i) { swapText(it.children[1], CHECKBOXROW_PROPS_180[i], CHECKBOXROW_PROPS[i]); });
      [[d.useList, 'A reviewer check (P3, 1.10.0): ticking saves it at once (Saving), then "Recorded by {name} on {dateTime}" and "Undo".'], [d.a11yList, CHECKBOXROW_A11Y[CHECKBOXROW_A11Y.length - 1]]].forEach(function (x) {
        const w = x[0].children[0].children[1].width + 16; const tmp = bullets([x[1]], w); tmp.children.slice().forEach(function (it) { x[0].appendChild(it); }); tmp.remove();
      });
      out.push('CheckboxRow Usage: Saving and Show undo');
    }
    return out;
  } });
  return steps;
}
// What the 1.10.0 templates need from CheckboxRow and SettingRow; a file that lacks one gets no Seller admin templates.
function sellerAdminLacks() {
  const out = [];
  const cb = S.sets.CheckboxRow, sr = S.sets.SettingRow;
  if (cb && cb.set) {
    if (!cb.keys['Show undo']) out.push('CheckboxRow Show undo');
    const noUndo = cb.set.children.filter(function (v) { return !v.children.some(function (k) { return k.name === 'undo'; }); }).length;
    if (noUndo) out.push('CheckboxRow undo action (' + noUndo + (noUndo === 1 ? ' variant' : ' variants') + ' without it)');
  }
  if (sr && sr.set) SETTINGROW_KEYS.forEach(function (k) { if (!sr.keys[k]) out.push('SettingRow ' + k); });
  return out;
}

// ==== 40_templates.js ====
// ---------------------------------------------------------------- templates (full screens from instances)
function prop(setName, propName, value) { const o = {}; o[S.sets[setName].keys[propName]] = value; return o; }
function setNested(root, name, props) { const n = root.findOne(function (x) { return x.name === name; }); if (n) n.setProperties(props); return n; }
function sidebarFor(ws, active, collapsed) {
  const sb = inst('Sidebar', { Workspace: ws, Collapsed: collapsed ? 'True' : 'False' }, { name: 'Sidebar', sizeV: 'FILL' });
  if (active === 'none') setNested(sb, 'nav-home', { State: 'Default' }); // 1.8.0: a page with no Sidebar item of its own (Team & roles until the nav-config release): nothing is active
  else if (active && active !== 'nav-home') { setNested(sb, 'nav-home', { State: 'Default' }); setNested(sb, active, { State: 'Active' }); }
  return sb;
}
function screen(name, ws, active, crumb, contentKids, o) {
  o = o || {};
  const col = frame({ name: 'Column', dir: 'V', sizeH: 'FILL', sizeV: o.fixedH ? 'FILL' : null }, [
    inst('Topbar', { Workspace: ws, Crumb: crumb }, { name: 'Topbar', sizeH: 'FILL' }),
    frame({ name: 'Main', dir: 'V', gap: o.gap || 'space/6', pad: o.pad || [28, 32, 40, 32], sizeH: 'FILL', sizeV: o.fixedH ? 'FILL' : null }, contentKids),
  ]);
  const scr = frame({ name: name, dir: 'H', w: o.w || 1440, h: o.fixedH, fill: 'bg/page', clip: true }, [sidebarFor(ws, active, o.collapsed), col]);
  if (o.minH && !o.fixedH) scr.minHeight = o.minH; // 1.8.1: a page that hugs its content is never shorter than this, so the FILL Sidebar holds its own items
  tag(scr);
  return scr;
}
function card(name, kids, o) {
  o = o || {};
  return frame({ name: name, dir: 'V', gap: o.gap, pad: o.pad, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', clip: true, sizeH: o.sizeH === undefined ? 'FILL' : o.sizeH, w: o.w }, kids);
}
function header(title, action, extra) {
  const props = { Title: title, 'Show action': !!action }; if (action) props.Action = action;
  const h = inst('CardHeader', props, { sizeH: 'FILL' });
  return h;
}
function pageTitle(title, subtitle, right, badge) {
  return frame({ name: 'Page header', dir: 'H', align: 'end', justify: 'between', sizeH: 'FILL' }, [
    frame({ name: 'Title', dir: 'V', gap: 'space/1' }, [frame({ name: 'title-row', dir: 'H', gap: 'space/3', align: 'center' }, [text(title, 'Heading/H1'), badge || null]), subtitle ? text(subtitle, 'Body/Default', 'text/muted') : null]),
    frame({ name: 'Actions', dir: 'H', gap: 'space/2', align: 'center' }, right || []),
  ]);
}
function btn(label, variant, size, extra) { const p = { Variant: variant || 'Secondary', Size: size || 'Md', State: 'Default', Label: label }; Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; }); return inst('Button', p); }
function stat(label, value, delta, trend, positive, o) { return inst('StatTile', { Trend: trend || 'Sparkline', Tone: positive ? 'Positive' : 'Neutral', Label: label, Value: value, Delta: delta }, Object.assign({ sizeH: 'FILL' }, o || {})); }
function kpiStrip(tiles) {
  const kids = []; tiles.forEach(function (t, i) { if (i) kids.push(rect({ name: 'divider', w: 1, h: 10, fill: 'border/default', sizeV: 'FILL' })); kids.push(t); });
  return card('KPI strip', [frame({ name: 'tiles', dir: 'H', sizeH: 'FILL' }, kids)]);
}
function cellBox(node, w, o) {
  o = o || {};
  return frame({ name: 'cell', dir: o.dir || 'H', w: w === 'fill' ? undefined : w, h: o.h || 56, px: 'space/3', gap: o.gap || 'space/2-5', align: o.align || 'center', justify: o.justify, fill: o.fill || 'bg/surface', stroke: 'border/row', sides: ['bottom'], sizeH: w === 'fill' ? 'FILL' : null }, Array.isArray(node) ? node : [node]);
}
function kindTitle(kind, title) { return frame({ name: 'kind-title', dir: 'V', sizeH: 'FILL' }, [text(kind, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true }), text(title, 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true })]); }
function twoLine(a, b, styleA) { return frame({ name: 'two-line', dir: 'V', sizeH: 'FILL' }, [text(a, styleA || 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), text(b, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })]); }
function headerRow(cols) {
  return frame({ name: 'Header row', dir: 'H', sizeH: 'FILL' }, cols.map(function (c) {
    const i = inst('TableCell', { Type: 'Header', State: 'Default', Text: c[0], Sorted: !!c[2] }, { name: 'th ' + c[0], sizeH: c[1] === 'fill' ? 'FILL' : null });
    if (c[1] !== 'fill') i.resize(c[1], i.height);
    return i;
  }));
}
function row(cells, sel, attention, h) {
  const fill = sel ? 'bg/row-selected' : (attention ? 'bg/row-attention' : 'bg/surface');
  return frame({ name: 'Row', dir: 'H', sizeH: 'FILL' }, cells.map(function (c) { return cellBox(c[0], c[1], Object.assign({ fill: fill, h: h }, c[2] || {})); }));
}
function checkbox(sel) { return inst('Checkbox', { Value: sel ? 'Checked' : 'Unchecked', State: 'Default' }); }
function thumbs(kinds) {
  return frame({ name: 'thumbs', dir: 'H', gap: -8 }, kinds.map(function (k) { return inst('ProductThumb', { Category: k, Size: 'Sm' }); }));
}

// ---- Admin · Home
function tplAdminHome() {
  const hero = card('Gross sales', [frame({ name: 'hero', dir: 'H', sizeH: 'FILL' }, [
    frame({ name: 'chart', dir: 'V', gap: 'space/1-5', pad: [18, 20, 14, 20], sizeH: 'FILL' }, [
      text('Gross sales today, incl. GST', 'Body/Strong', 'text/secondary'),
      frame({ name: 'value', dir: 'H', gap: 'space/2-5', align: 'center' }, [text('AUD 12,904.60', 'Display/Hero'), inst('Badge', { Tone: 'Success', Leading: 'Icon', Label: '8.2%', Icon: { icon: 'arrow-up' } }), text('vs AUD 11,926.58 at 2:30 pm yesterday', 'Body/Default', 'text/muted')]),
      inst('TrendChart', {}, { name: 'TrendChart' }),
    ]),
    frame({ name: 'kpis', dir: 'V', w: 280, fill: 'bg/subtle', stroke: 'border/default', sides: ['left'], sizeV: 'FILL' }, [
      stat('Orders', '184', '↑ 12 vs yesterday', 'Sparkline', true), stat('Average order', 'AUD 70.13', 'Incl. GST', 'Sparkline', false), stat('Sellers taking orders', '41 of 109', '38% of active sellers', 'Meter', false), stat('Dispatched on time', '97.6%', 'Target 95%', 'Sparkline', false),
    ]),
  ])]);
  const queues = frame({ name: 'Review queues', dir: 'H', gap: 'space/4', sizeH: 'FILL' }, [
    inst('QueueCard', { Tone: 'On track', Title: 'Seller applications', Count: '6', Oldest: 'Oldest 2 days of 3' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'Overdue', Title: 'Certifications', Count: '4' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'On track', Title: 'Product revisions', Count: '23', Oldest: 'Oldest 5 h of 1 day' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'Due today', Title: 'Refunds for admin', Count: '2', Unit: 'AUD 184.50 incl. GST' }, { sizeH: 'FILL' }),
  ]);
  const RQ = [['CE', 'Teal', 'Certification', 'Halal certificate, renewal', 'Kuraby Fresh', 'Waiting 2 days 4 h', 'Overdue'], ['RF', 'Amber', 'Refund · order MP-10311', 'Item damaged, AUD 64.50', 'Darra Asian Mart', 'Waiting 4 h', 'Due soon'],
    ['PR', 'Blue', 'Product revision · price +38%', 'Date & walnut loaf, 800 g', 'Holland Park Bakehouse', 'Waiting 5 h', 'Due soon'], ['MC', 'Teal', 'Manufacturer certificate', 'Covers 14 sealed products', 'Logan Family Grocer', 'Waiting 21 h', 'Upcoming'],
    ['SA', 'Purple', 'Seller application', 'New seller, ABN supplied', 'Sunnybank Spice Market', 'Waiting 1 day', 'Upcoming']];
  const DLL = { 'Overdue': 'Overdue 4 h', 'Due soon': 'Due 5:00 pm', 'Upcoming': 'Due 2 Oct' };
  const rq = card('Review queue', [header('Review queue', 'Open full queue'),
    frame({ name: 'tabs', dir: 'H', px: 'space/3-5', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [inst('Tab', { Selected: 'True', Label: 'All', Count: '35' }), inst('Tab', { Selected: 'False', Label: 'Sellers', Count: '6' }), inst('Tab', { Selected: 'False', Label: 'Certifications', Count: '4' }), inst('Tab', { Selected: 'False', Label: 'Products', Count: '23' }), inst('Tab', { Selected: 'False', Label: 'Refunds', Count: '2' })]),
    headerRow([['Item', 'fill'], ['Seller', 220], ['Deadline', 170], ['', 100]]),
  ].concat(RQ.map(function (r) {
    const d = inst('DeadlineBadge', { Tone: r[6] }); setNested(d, 'badge', prop('Badge', 'Label', DLL[r[6]]));
    return row([[[inst('IdentityTile', { Tone: r[1], Shape: 'Rounded', Initials: r[0] }), kindTitle(r[2], r[3])], 'fill'], [twoLine(r[4], r[5], 'Body/Default'), 220], [d, 170], [btn('Review', 'Secondary', 'Sm'), 100, { justify: 'end' }]], false, false, 64);
  })));
  const map = inst('DeliveryMap', {}, { name: 'DeliveryMap' }); map.resize(380, 224);
  const legend = frame({ name: 'legend', dir: 'H', gap: 'space/3-5', px: 'space/4-5', py: 'space/2-5', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [
    frame({ name: 'k1', dir: 'H', gap: 'space/1-5', align: 'center' }, [ellipse({ w: 10, fill: 'map/seller-pin' }), text('Seller with open orders', 'Caption/Default', 'text/secondary')]),
    frame({ name: 'k2', dir: 'H', gap: 'space/1-5', align: 'center' }, [ellipse({ w: 8, fill: 'map/courier' }), text('Courier', 'Caption/Default', 'text/secondary')]),
    frame({ name: 'k3', dir: 'H', gap: 'space/1-5', align: 'center' }, [vector({ d: 'M 0 0 L 14 0', stroke: 'action/primary', strokeW: 1.5, dash: [3, 3] }), text('Service area', 'Caption/Default', 'text/secondary')]),
  ]);
  const stats = frame({ name: 'stats', dir: 'H', sizeH: 'FILL' }, [['In transit', '23'], ['Avg delivery', '34 min'], ['Late now', '2']].map(function (s2, i) {
    return frame({ name: s2[0], dir: 'V', gap: 'space/0-5', px: 'space/4-5', py: 'space/3', sizeH: 'FILL', stroke: i < 2 ? 'border/row' : null, sides: ['right'] }, [text(s2[0], 'Caption/Default', 'text/muted'), text(s2[1], 'Heading/H2', i === 2 ? 'status/attention/fg' : 'text/primary')]);
  }));
  const live = card('Live deliveries', [frame({ name: 'head', dir: 'H', pad: [16, 18, 12, 18], justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Live deliveries', 'Heading/H2'), inst('Badge', { Tone: 'Success', Leading: 'Dot', Label: 'Live · 2:30 pm' })]), map, legend, stats], { sizeH: null, w: 380 });
  const split = frame({ name: 'Queue + map', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [rq, live]);

  const TOP = [['KF', 'Teal', 'Kuraby Fresh', '34 orders · Kuraby', 'AUD 2,146.90'], ['HP', 'Amber', 'Holland Park Bakehouse', '29 orders · Holland Park', 'AUD 1,388.20'], ['DA', 'Blue', 'Darra Asian Mart', '22 orders · Darra', 'AUD 1,204.75'], ['LF', 'Purple', 'Logan Family Grocer', '18 orders · Logan Central', 'AUD 986.40']];
  const top = card('Top sellers', [header('Top sellers today', 'All sellers'), headerRow([['Seller', 'fill'], ['Today', 100], ['Sales', 120]])].concat(TOP.map(function (t) {
    return row([[[inst('IdentityTile', { Tone: t[1], Shape: 'Rounded', Initials: t[0] }), twoLine(t[2], t[3])], 'fill'], [inst('Sparkline', { Tone: 'Accent' }), 100], [text(t[4], 'Body/Strong'), 120, { justify: 'end' }]]);
  })));
  const certs = card('Certificates', [header('Certificates', null), frame({ name: 'donut-row', dir: 'H', gap: 'space/3-5', pad: [0, 18, 12, 18], align: 'center' }, [inst('DonutProgress', {}), frame({ name: 't', dir: 'V' }, [text('92 of 109 hold a valid certificate', 'Body/Strong'), text('78 seller · 14 manufacturer only', 'Body/Small', 'text/muted')])]),
    frame({ name: 'list', dir: 'V', pad: [0, 18, 8, 18], sizeH: 'FILL' }, [text('Expiring in 30 days', 'Caption/Overline', 'text/muted')].concat([['Kuraby Fresh', 'Seller', '14 days', 'status/attention/fg'], ['Darra Asian Mart', 'Seller', '22 days', 'text/secondary'], ['Logan Family Grocer', 'Manufacturer', '29 days', 'text/secondary']].map(function (e) {
      return frame({ name: e[0], dir: 'H', justify: 'between', align: 'center', py: 'space/2-5', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [frame({ name: 'l', dir: 'V', gap: 'space/1' }, [text(e[0], 'Body/Strong'), inst('CertChip', { Kind: e[1] })]), text(e[2], 'Body/Small Strong', e[3])]);
    })))], { sizeH: null, w: 340 });
  const payout = card('Payout', [header('Next payout batch', null), frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 18, 18, 18], sizeH: 'FILL' }, [
    frame({ name: 'amount', dir: 'V' }, [text('AUD 18,420.35', 'Heading/Amount'), text('12 sellers · Mon 6 Oct 2026', 'Body/Small', 'text/muted')]),
    inst('SplitBar', {}, { sizeH: 'FILL' }),
    frame({ name: 'dl', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [['To sellers', '18,420.35'], ['Commission', '3,251.65'], ['Invoiced sales', '21,672.00']].map(function (d) { return frame({ name: d[0], dir: 'H', justify: 'between', sizeH: 'FILL' }, [text(d[0], 'Body/Small', 'text/secondary'), text(d[1], 'Body/Small Strong')]); })),
    btn('Review batch', 'Secondary', 'Md'),
  ])], { sizeH: null, w: 320 });
  payout.children[1].children[3].layoutSizingHorizontal = 'FILL';
  const row3 = frame({ name: 'Row 3', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [top, certs, payout]);
  return screen('Admin · Home', 'Admin', 'nav-home', 'Home', [
    pageTitle('Good afternoon, Layla', 'Thursday 1 Oct 2026 · 2:30 pm Brisbane time (AEST, UTC+10) · 35 items waiting for review', [inst('SegmentedControl', {}), btn('View audit log'), btn('Start reviewing', 'Primary')]),
    hero, queues, split, row3,
  ]);
}

// ---- Admin · Sellers
function tplAdminSellers() {
  const S1 = [
    [true, 'KF', 'Teal', 'Kuraby Fresh', 'kuraby-fresh · Kuraby QLD 4112', ['Success', 'Dot', 'Active'], [['Seller', '· exp 15 Oct']], 'Healthy', '412', '0.8%', '12 Mar 2026'],
    [true, 'SS', 'Purple', 'Sunnybank Spice Market', 'sunnybank-spice · Sunnybank QLD 4109', ['Info', 'Icon', 'Awaiting approval'], [], 'No data', '0', '—', '29 Sep 2026'],
    [false, 'DA', 'Blue', 'Darra Asian Mart', 'darra-asian-mart · Darra QLD 4076', ['Success', 'Dot', 'Active'], [['Seller', '· exp 23 Oct']], 'At risk', '268', '3.1%', '4 Apr 2026'],
    [false, 'LF', 'Neutral', 'Logan Family Grocer', 'logan-family-grocer · Logan Central QLD 4114', ['Success', 'Dot', 'Active'], [['Manufacturer']], 'Healthy', '190', '1.2%', '18 May 2026'],
    [false, 'HP', 'Amber', 'Holland Park Bakehouse', 'holland-park-bakehouse · Holland Park QLD 4121', ['Success', 'Dot', 'Active'], [['Seller'], ['Vegan']], 'Healthy', '356', '0.4%', '2 Feb 2026'],
    [false, 'SC', 'Neutral', 'Slacks Creek Butchers', 'slacks-creek-butchers · Slacks Creek QLD 4127', ['Critical', 'Icon', 'Suspended'], [['Revoked']], 'Unhealthy', '12', '9.8%', '20 Jan 2026'],
    [false, 'WO', 'Teal', 'Woolloongabba Grocers', 'gabba-grocers · Woolloongabba QLD 4102', ['Success', 'Dot', 'Active'], [['Self-declared']], 'Healthy', '97', '0.0%', '7 Jul 2026'],
  ];
  const tableCard = card('Seller list', [
    frame({ name: 'tabs', dir: 'H', px: 'space/3-5', align: 'center', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [inst('Tab', { Selected: 'True', Label: 'All', Count: '128' }), inst('Tab', { Selected: 'False', Label: 'Awaiting approval', Count: '6' }), inst('Tab', { Selected: 'False', Label: 'Active', Count: '109' }), inst('Tab', { Selected: 'False', Label: 'Certificate expiring', Count: '5' }), inst('Tab', { Selected: 'False', Label: 'Suspended', Count: '3' })]),
    frame({ name: 'filters', dir: 'H', gap: 'space/2', align: 'center', px: 'space/3-5', py: 'space/3', sizeH: 'FILL' }, [inst('Input', { State: 'Default', Value: 'Name, email or ABN' }), inst('FilterChip', { Type: 'Applied', Label: 'Service area: Greater Brisbane' }), inst('FilterChip', { Type: 'Add' }), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Sort: Newest'), btn('Columns', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'columns' } })]),
    headerRow([['', 46], ['Seller', 'fill'], ['Status', 170], ['Certifications', 220], ['Health', 120], ['Orders, 30 days', 130], ['Cancelled', 96], ['Joined', 120, true], ['', 56]]),
  ].concat(S1.map(function (r) {
    const status = inst('Badge', { Tone: r[5][0], Leading: r[5][1], Label: r[5][2] }); if (r[5][1] === 'Icon') status.setProperties(prop('Badge', 'Icon', S.icons[r[5][0] === 'Critical' ? 'ban' : 'clock'].id));
    const certs = r[6].length ? r[6].map(function (c) { const i = inst('CertChip', { Kind: c[0] }); if (c[1]) i.setProperties(Object.assign(prop('CertChip', 'Note', c[1]), prop('CertChip', 'Show note', true))); return i; }) : [text('None yet', 'Body/Default', 'text/muted')];
    return row([[checkbox(r[0]), 46, { justify: 'center' }], [[inst('IdentityTile', { Tone: r[2], Shape: 'Rounded', Initials: r[1] }), twoLine(r[3], r[4])], 'fill'], [status, 170], [certs, 220, { gap: 'space/1-5' }], [inst('HealthIndicator', { State: r[7] }), 120],
      [[r[8] !== '0' ? inst('Sparkline', { Tone: r[7] === 'Unhealthy' ? 'Attention' : 'Accent' }) : null, text(r[8], 'Body/Default')], 130, { justify: 'end' }], [text(r[9], r[9] === '9.8%' || r[9] === '3.1%' ? 'Body/Strong' : 'Body/Default', r[9] === '9.8%' ? 'status/critical/fg' : (r[9] === '3.1%' ? 'status/attention/fg' : 'text/primary')), 96, { justify: 'end' }],
      [text(r[10], 'Body/Default'), 120], [inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default' }), 56, { justify: 'center' }]], r[0]);
  })).concat([inst('Pagination', { Range: '1–25 of 128' }, { sizeH: 'FILL' })]));
  const bulk = inst('BulkActionBar', {}, { name: 'BulkActionBar' });
  return screen('Admin · Sellers', 'Admin', 'nav-sellers', 'Sellers', [
    pageTitle('Sellers', '128 sellers in the Australia market', [btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Add seller', 'Primary', 'Md', { 'Leading icon': true, Icon: { icon: 'plus' } })]),
    kpiStrip([stat('Active sellers', '109', '↑ 4 this month', 'Sparkline', true), stat('Sales, 30 days', 'AUD 412,860', '↑ 9.4% vs previous 30 days', 'Sparkline', true), stat('Dispatched on time', '96.1%', 'Target 95%', 'Sparkline', false), stat('Need attention', '12', '5 expiring · 4 at risk · 3 suspended', 'Sparkline', false)]),
    tableCard, frame({ name: 'bulk-wrap', dir: 'H', justify: 'center', sizeH: 'FILL' }, [bulk]),
  ], { gap: 'space/5' });
}

// ---- Admin · Certificate review
function tplAdminReview() {
  const facts = card('Facts', [frame({ name: 'facts', dir: 'H', py: 'space/3-5', sizeH: 'FILL' }, [['Type', 'Halal · third-party certificate'], ['Issuer', '[Issuer name]'], ['Valid', '10 Sep 2026 to 9 Sep 2027'], ['Offers covered', '38'], ['Assigned to', 'Layla Haddad'], ['Decision due', '1 Oct, 10:24 am']].map(function (f, i) {
    return frame({ name: f[0], dir: 'V', gap: 'space/1', px: 'space/5', stroke: i ? 'border/default' : null, sides: ['left'] }, [text(f[0], 'Body/Small', 'text/muted'), text(f[1], 'Body/Strong', i === 5 ? 'status/critical/fg' : 'text/primary')]);
  }))]);
  const paper = frame({ name: 'Document page', w: 360, h: 456, fill: 'bg/surface', radius: 4, effect: 'Elevation/Document' });
  add(paper, ellipse({ name: 'seal', w: 52, fill: 'cert/seller/bg', stroke: 'cert/seller/fg', strokeW: 1.6, xy: [154, 36] }));
  add(paper, text('[ ISSUER NAME ]', 'Mono/Small', 'text/muted', { xy: [136, 102] }));
  add(paper, text('HALAL CERTIFICATE', 'Heading/H2', 'cert/seller/fg', { xy: [104, 120] }));
  [['Certificate no.', '[Certificate number]', 'action/primary'], ['Holder', 'Kuraby Fresh Pty Ltd', 'cert/seller/fg'], ['Premises', 'Kuraby QLD 4112'], ['Scope', 'Fresh meat and poultry'], ['Valid', '10 Sep 2026 to 9 Sep 2027']].forEach(function (r2, i) {
    const y = 190 + i * 26;
    if (r2[2]) add(paper, rect({ name: 'highlight', w: 196, h: 22, fill: r2[2] === 'action/primary' ? 'bg/selected' : 'cert/seller/bg', stroke: r2[2], strokeW: 1.2, radius: 3, xy: [120, y - 3] }));
    add(paper, text(r2[0], 'Caption/Default', 'text/muted', { xy: [40, y] })); add(paper, text(r2[1], 'Caption/Strong', 'text/primary', { xy: [126, y] }));
    add(paper, rect({ name: 'rule', w: 280, h: 1, fill: 'border/row', xy: [40, y + 20] }));
  });
  add(paper, text('Page 1 of 2 · sample preview', 'Mono/Small', 'text/muted', { xy: [116, 424] }));
  const viewer = frame({ name: 'viewer', dir: 'H', justify: 'center', pad: [24, 16, 24, 16], fill: 'bg/muted', sizeH: 'FILL', sizeV: 'FILL' }, [paper]);
  const fields = frame({ name: 'Read from document', dir: 'V', w: 260, stroke: 'border/default', sides: ['left'], sizeV: 'FILL' }, [
    frame({ name: 'h', dir: 'H', pad: [12, 14, 8, 14] }, [text('Read from document', 'Caption/Overline', 'text/muted')]),
    inst('ExtractedField', { Status: 'Check now', Label: 'Certificate no.', Value: '[Certificate number]' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'Matches', Label: 'Holder', Value: 'Kuraby Fresh Pty Ltd' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'Matches', Label: 'Issuer', Value: '[Issuer name]' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'To check', Label: 'Scope', Value: 'Fresh meat and poultry, one premises in Kuraby QLD 4112' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'Matches', Label: 'Valid', Value: '10 Sep 2026 to 9 Sep 2027' }, { sizeH: 'FILL' }),
  ]);
  const doc = card('Submitted document', [
    frame({ name: 'toolbar', dir: 'H', gap: 'space/2-5', align: 'center', pad: [10, 14, 10, 14], stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [icon('file', 'icon/default', 18), text('halal-certificate-2026.pdf', 'Body/Strong'), text('2 pages · 412 KB · stored locked', 'Body/Small', 'text/muted'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'zoom-out' } }), text('100%', 'Body/Small'), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'zoom-in' } }), text('Open original', 'Body/Strong', 'text/link')]),
    frame({ name: 'doc-body', dir: 'H', sizeH: 'FILL' }, [viewer, fields]),
  ]);
  const activity = card('Activity', [header('Activity', null), frame({ name: 'events', dir: 'V', pad: [0, 18, 6, 18], sizeH: 'FILL' }, [
    inst('TimelineItem', { Tone: 'Blue', Who: 'Layla Haddad', What: 'confirmed the name and ABN', When: 'Today, 2:12 pm' }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Info', Who: 'MondaPac Support', What: 'messaged the seller', When: 'Today, 11:05 am', 'Show quote': true }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Blue', Who: 'Layla Haddad', What: 'was assigned this review', When: 'Today, 9:02 am' }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Neutral', Who: 'Automatic checks', What: 'passed: issuer registry, dates', When: '29 Sep, 10:25 am' }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Teal', Who: 'Yusuf Karimi', What: 'submitted the renewal', When: '29 Sep, 10:24 am' }, { sizeH: 'FILL' }),
  ])]);
  const checks = card('Checks', [frame({ name: 'h', dir: 'V', gap: 'space/2-5', pad: [16, 18, 12, 18], sizeH: 'FILL' }, [frame({ name: 't', dir: 'H', justify: 'between', sizeH: 'FILL' }, [text('Checks', 'Heading/H2'), text('3 of 5 done', 'Body/Small', 'text/muted')]), frame({ name: 'pips', dir: 'H', gap: 3, sizeH: 'FILL' }, [0, 1, 2, 3, 4].map(function (i) { return rect({ name: 'pip', w: 40, h: 6, radius: 3, fill: i < 3 ? 'status/success/fg' : 'border/default', sizeH: 'FILL' }); }))]),
    inst('ChecklistItem', { State: 'Done', Title: 'Issuer is in the approved registry for Australia', By: 'Checked automatically · 29 Sep, 10:25 am' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'Done', Title: 'Dates are valid and expiry is after today', By: 'Checked automatically · 29 Sep, 10:25 am' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'Done', Title: 'Name matches the registered business name and ABN', By: 'Confirmed by Layla Haddad · today, 2:12 pm' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'To do', Title: 'Certificate number confirmed with the issuer' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'To do', Title: 'Scope covers what this seller sells (fresh meat, poultry)' }, { sizeH: 'FILL' }),
  ]);
  const decision = card('Decision', [frame({ name: 'b', dir: 'V', gap: 'space/3', pad: [16, 18, 16, 18], sizeH: 'FILL' }, [
    text('Decision', 'Heading/H2'),
    frame({ name: 'impact', dir: 'V', gap: 'space/2', pad: 12, fill: 'status/attention/surface', stroke: 'status/attention/border', radius: 'radius/control', sizeH: 'FILL' }, [text('If approved, the Halal label stays on this seller’s 38 offers after 15 Oct 2026. If no decision is made, the label is removed when the current certificate ends.', 'Body/Small', 'text/secondary', { sizeH: 'FILL' }), frame({ name: 'm', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [inst('Meter', { Tone: 'Attention', Value: '50' }, { sizeH: 'FILL' }), text('14 days left', 'Caption/Strong', 'status/attention/fg')])]),
    frame({ name: 'buttons', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [btn('Approve', 'Primary', 'Md', { State: 'Disabled' }), btn('Reject…', 'Destructive', 'Md')]),
    text('Ask seller for more information', 'Body/Strong', 'text/link'),
    text('Complete the 2 remaining checks to approve. Rejecting needs a reason the seller will see.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
  ])]);
  decision.children[0].children[2].children.forEach(function (b) { b.layoutSizingHorizontal = 'FILL'; });
  const left = frame({ name: 'Left', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [doc, activity]);
  const right = frame({ name: 'Right', dir: 'V', gap: 'space/4', w: 380 }, [checks, decision]);
  return screen('Admin · Certificate review', 'Admin', 'nav-review', 'Review queue', [
    frame({ name: 'Header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text('‹ Review queue', 'Body/Strong', 'text/link'), pageTitle('Halal certificate renewal', 'Kuraby Fresh · submitted 29 Sep 2026, 10:24 am AEST by Yusuf Karimi (Shop owner)', [text('2 of 4 certifications', 'Body/Small', 'text/muted'), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'chevron-left' } }), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'chevron-right' } })],
      frame({ name: 'badges', dir: 'H', gap: 'space/2' }, [inst('StatusBadge', { Status: 'In review' }), inst('Badge', { Tone: 'Critical', Leading: 'Icon', Label: 'Deadline passed 4 h ago', Icon: { icon: 'alert-circle' } })]))]),
    facts, frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [left, right]),
  ], { gap: 'space/5', pad: [24, 32, 40, 32] });
}

// ==== 41_templates_seller.js ====
// ---- Seller · Home
function stageCard(title, count, note, n, token, urgent) {
  return frame({ name: title, dir: 'V', gap: 'space/2-5', pad: 18, fill: 'bg/surface', stroke: urgent ? 'status/attention/border' : 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
    frame({ name: 'h', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [text(title, 'Body/Strong', 'text/secondary'), urgent ? inst('Badge', { Tone: 'Attention', Leading: 'None', Label: 'Accept now' }) : null]),
    text(count, 'Display/Hero'),
    frame({ name: 'pips', dir: 'H', gap: 3, wrap: true, rowGap: 3, sizeH: 'FILL' }, Array.apply(null, Array(Math.min(n, 12))).map(function () { return rect({ name: 'pip', w: 20, h: 6, radius: 3, fill: token }); })),
    text(note, 'Body/Small', 'text/muted'),
  ]);
}
function tplSellerHome() {
  const stages = frame({ name: 'Order stages', dir: 'H', gap: 'space/4', sizeH: 'FILL' }, [
    stageCard('Needs action', '3', 'Oldest waiting 9 min', 3, 'status/attention/solid', true), stageCard('Preparing', '5', 'Next ready by 2:48 pm', 5, 'action/primary'),
    stageCard('Ready for pickup', '2', 'Courier arriving 2:41 pm', 2, 'cert/seller/fg'), stageCard('Scheduled for tomorrow', '11', 'Next-day delivery, 9 am to 1 pm', 11, 'border/input'),
  ]);
  const ACC = [['MP-10482', 'Waiting 9 min', 'status/critical/fg', ['Meat', 'Meat', 'Poultry'], '3 items', 'Lamb cutlets, beef mince, chicken wings', 'Instant', 'By 2:50 pm · 20 min left', 'AUD 86.40'],
    ['MP-10483', 'Waiting 4 min', 'status/attention/fg', ['Poultry'], '1 item', 'Chicken thigh fillets, 1 kg', 'Instant', 'By 2:55 pm · 25 min left', 'AUD 32.90'],
    ['MP-10479', 'Accept by 6 pm', 'text/muted', ['Meat', 'Poultry', 'Pantry'], '5 items', 'Lamb leg, chicken breast, sausages, basmati rice, BBQ charcoal', 'Next day', 'Fri 2 Oct, 9 to 11 am', 'AUD 142.75']];
  const accept = card('Orders needing action', [header('Orders needing action', 'Open order board'), headerRow([['Order', 136], ['Items', 'fill'], ['Delivery', 180], ['Total', 100], ['', 100]])].concat(ACC.map(function (r) {
    return row([[frame({ name: 'o', dir: 'V' }, [text(r[0], 'Mono/Default'), text(r[1], 'Caption/Strong', r[2])]), 136], [[thumbs(r[3]), twoLine(r[4], r[5])], 'fill'],
      [frame({ name: 'd', dir: 'V', gap: 'space/1' }, [inst('Badge', { Tone: r[6] === 'Instant' ? 'Attention' : 'Neutral', Leading: 'None', Label: r[6] }), text(r[7], 'Caption/Default', 'text/muted')]), 180],
      [text(r[8], 'Body/Default'), 100, { justify: 'end' }], [btn('Accept', 'Primary', 'Sm'), 100, { justify: 'end' }]], false, false, 64);
  })));
  const PREP = [['MP-10481', 'Lamb mince ×2, beef rump steak, Turkish bread', '2:48 pm', '18 min left', 'Attention', '75'], ['MP-10480', 'Chicken drumsticks 1 kg, pita bread', '2:52 pm', '22 min left', 'Accent', '50'], ['MP-10478', 'Beef brisket 1.5 kg', '3:05 pm', '35 min left', 'Accent', '25'], ['MP-10477', 'Mixed grill pack, garlic sauce', '3:10 pm', '40 min left', 'Accent', '25'], ['MP-10475', 'Goat curry cuts 1 kg, basmati rice 5 kg', '3:20 pm', '50 min left', 'Accent', '0']];
  const prep = card('Preparing now', [frame({ name: 'h', dir: 'H', pad: [16, 18, 12, 18], justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Preparing now', 'Heading/H2'), text('5 orders · courier pickups every 10 min', 'Body/Small', 'text/muted')])].concat(PREP.map(function (p) {
    return frame({ name: p[0], dir: 'H', gap: 'space/3-5', align: 'center', pad: [11, 18, 11, 18], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(p[0], 'Mono/Default', 'text/primary'), text(p[1], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true }),
      frame({ name: 'time', dir: 'V', gap: 'space/1', w: 190 }, [frame({ name: 't', dir: 'H', justify: 'between', sizeH: 'FILL' }, [text('Ready by ' + p[2], 'Body/Small', 'text/muted'), text(p[3], 'Body/Small Strong', p[4] === 'Attention' ? 'status/attention/fg' : 'status/info/fg')]), inst('Meter', { Tone: p[4], Value: p[5] }, { sizeH: 'FILL' })])]);
  })));
  const msgs = card('Messages', [header('Messages', 'All messages')].concat([['AR', 'Amber', 'Amina R.', 'MP-10479', 'Could you cut the lamb leg into 4 pieces please? Thank you!', '2:21 pm', true], ['MP', 'Blue', 'MondaPac Support', 'Certificate', 'We received your renewal. The review is taking longer than usual this week.', '11:05 am', true], ['CL', 'Teal', 'Chris L.', 'MP-10470', 'Arrived cold and well packed. Will order again next week.', 'Yesterday', false]].map(function (m) {
    return frame({ name: m[2], dir: 'H', gap: 'space/3', align: 'center', pad: [11, 18, 11, 18], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [inst('IdentityTile', { Tone: m[1], Shape: 'Circle', Initials: m[0] }), frame({ name: 'c', dir: 'V', sizeH: 'FILL' }, [frame({ name: 'w', dir: 'H', gap: 'space/2' }, [text(m[2], 'Body/Strong'), text(m[3], 'Caption/Default', 'text/muted')]), text(m[4], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true })]), text(m[5], 'Caption/Default', 'text/muted'), m[6] ? ellipse({ name: 'unread', w: 8, fill: 'action/primary' }) : null]);
  })));
  const payout = card('Next payout', [header('Next payout', null), frame({ name: 'b', dir: 'V', gap: 'space/3', pad: [0, 18, 16, 18], sizeH: 'FILL' }, [
    frame({ name: 'a', dir: 'V' }, [text('AUD 2,318.40', 'Heading/Amount'), text('Mon 6 Oct · to account ending 4821', 'Body/Small', 'text/muted')]), inst('WeeklyBars', {}),
    frame({ name: 'dl', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [['Invoiced sales', '2,634.55'], ['Commission', '−316.15']].map(function (d) { return frame({ name: d[0], dir: 'H', justify: 'between', sizeH: 'FILL' }, [text(d[0], 'Body/Small', 'text/secondary'), text(d[1], 'Body/Small Strong')]); })),
    text('See transactions', 'Body/Strong', 'text/link'),
  ])], { sizeH: 'FILL' });
  const low = card('Low stock', [header('Low stock', 'Update inventory')].concat([['Meat', 'Lamb shoulder, bone-in (kg)', '4 left · sells about 6 a day', 'status/critical/fg'], ['Poultry', 'Chicken thigh fillets, 1 kg', '6 left', 'status/attention/fg'], ['Meat', 'Beef mince, 500 g', '8 left', 'status/attention/fg']].map(function (l) {
    return frame({ name: l[1], dir: 'H', gap: 'space/2-5', align: 'center', pad: [10, 18, 10, 18], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [inst('ProductThumb', { Category: l[0], Size: 'Md' }), frame({ name: 'c', dir: 'V', sizeH: 'FILL' }, [text(l[1], 'Body/Default', 'text/primary', { sizeH: 'FILL', truncate: true }), text(l[2], 'Body/Small Strong', l[3])]), btn('Restock', 'Secondary', 'Sm')]);
  })));
  const certs = card('Certifications', [header('Certifications', null), frame({ name: 'b', dir: 'V', gap: 'space/3', pad: [0, 18, 16, 18], sizeH: 'FILL' }, [
    frame({ name: 'current', dir: 'H', gap: 'space/3', align: 'center', pad: 12, fill: 'cert/seller/bg', stroke: 'cert/seller/border', radius: 'radius/control', sizeH: 'FILL' }, [frame({ name: 'ok', dir: 'H', w: 36, h: 36, align: 'center', justify: 'center', fill: 'cert/seller/fg', radius: 'radius/pill' }, [icon('check', 'text/on-accent', 18)]), frame({ name: 't', dir: 'V' }, [text('Halal · seller certificate', 'Body/Strong', 'cert/seller/fg'), text('Valid until 15 Oct 2026 · 38 offers', 'Body/Small', 'text/secondary')])]),
    text('Renewal progress', 'Body/Small Strong', 'text/secondary'),
    frame({ name: 'steps', dir: 'H', gap: 'space/1', sizeH: 'FILL' }, [['Submitted', 'cert/seller/fg', 'cert/seller/fg'], ['Auto checks', 'cert/seller/fg', 'cert/seller/fg'], ['In review', 'action/primary', 'text/link'], ['Decision', 'border/default', 'text/muted']].map(function (st) {
      return frame({ name: st[0], dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [rect({ name: 'bar', w: 60, h: 5, radius: 3, fill: st[1], sizeH: 'FILL' }), text(st[0], 'Caption/Strong', st[2])]);
    })),
  ])]);
  const left = frame({ name: 'Left', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [accept, prep, msgs]);
  const right = frame({ name: 'Right', dir: 'V', gap: 'space/4', w: 340 }, [payout, low, certs]);
  return screen('Seller · Home', 'Seller', 'nav-home', 'Home', [
    pageTitle('Good afternoon, Yusuf', 'Thursday 1 Oct 2026 · 2:30 pm AEST', [btn('View shop'), btn('Add offer', 'Primary')], inst('Badge', { Tone: 'Success', Leading: 'Dot', Label: 'Open · taking orders until 8:00 pm' })),
    inst('InfoBanner', { Tone: 'Info' }, { sizeH: 'FILL' }), stages,
    kpiStrip([stat('Sales today', 'AUD 2,146.90', '↑ 11% vs last Thu', 'Sparkline', true), stat('Orders today', '34', '↑ 4 vs last Thu', 'Sparkline', true), stat('Average prep time', '14 min', 'Target under 20 min', 'Sparkline', false), stat('Dispatched on time', '98%', 'Target 95% or more', 'Sparkline', false)]),
    frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [left, right]),
  ]);
}

// ---- Seller · Orders
function tplSellerOrders() {
  const O = [
    [true, 'MP-10483', '2:26 pm', 'Instant', 'Ready by 2:55 pm · 25 min', ['Poultry'], '1 item', 'AUD 32.90', 'Needs action', 'Waiting 4 min', '—'],
    [true, 'MP-10482', '2:21 pm', 'Instant', 'Ready by 2:50 pm · 20 min', ['Meat', 'Meat', 'Poultry'], '3 items', 'AUD 86.40', 'Needs action', 'Waiting 9 min', '—'],
    [false, 'MP-10481', '2:14 pm', 'Instant', 'Ready by 2:48 pm · 18 min', ['Meat', 'Meat', 'Bakery'], '4 items', 'AUD 58.20', 'Preparing', 'Accepted 2:15 pm', '—'],
    [false, 'MP-10479', '2:02 pm', 'Next day', 'Fri 2 Oct, 9 to 11 am', ['Meat', 'Poultry', 'Pantry'], '5 items', 'AUD 142.75', 'Needs action', 'Accept by 6:00 pm', '—'],
    [false, 'MP-10476', '1:47 pm', 'Instant', 'Ready by 2:15 pm', ['Poultry', 'Meat'], '2 items', 'AUD 41.00', 'Ready for pickup', 'Courier arriving 2:41 pm', '—'],
    [false, 'MP-10470', '1:05 pm', 'Instant', 'Delivered 1:52 pm', ['Meat', 'Bakery', 'Pantry'], '6 items', 'AUD 118.30', 'Delivered', 'Invoice MPI-2291', 'Pending'],
    [false, 'MP-10466', '12:40 pm', 'Instant', 'Not delivered', ['Poultry', 'Other'], '2 items', 'AUD 27.80', 'Cancelled', 'Reason: item unavailable', 'Not payable'],
    [false, 'MP-10461', '11:58 am', 'Next day', 'Fri 2 Oct, 11 am to 1 pm', ['Meat', 'Pantry'], '3 items', 'AUD 64.10', 'Scheduled', 'Pick list at 8:00 am', '—'],
  ];
  const tableCard = card('Order list', [
    frame({ name: 'tabs', dir: 'H', px: 'space/3-5', align: 'center', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [['All', '34', 'True'], ['Needs action', '3'], ['Preparing', '5'], ['Ready', '2'], ['Scheduled', '11'], ['Completed', '12']].map(function (t) { return inst('Tab', { Selected: t[2] || 'False', Label: t[0], Count: t[1] }); })),
    frame({ name: 'filters', dir: 'H', gap: 'space/2', align: 'center', px: 'space/3-5', py: 'space/3', sizeH: 'FILL' }, [inst('Input', { State: 'Default', Value: 'Order number or product' }), inst('FilterChip', { Type: 'Applied', Label: 'Placed: Today' }), inst('FilterChip', { Type: 'Add' }), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Sort: Newest'), btn('Columns', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'columns' } })]),
    headerRow([['', 46], ['Order', 140, true], ['Delivery', 'fill'], ['Items', 150], ['Total', 110], ['Status', 220], ['Payout', 110], ['', 56]]),
  ].concat(O.map(function (r) {
    const mode = frame({ name: 'mode', dir: 'H', w: 28, h: 28, align: 'center', justify: 'center', fill: r[3] === 'Instant' ? 'status/attention/bg' : 'status/neutral/bg', radius: 'radius/control' }, [icon(r[3] === 'Instant' ? 'zap' : 'calendar', r[3] === 'Instant' ? 'status/attention/fg' : 'status/neutral/fg', 14)]);
    const win = r[4].indexOf('min') > 0;
    return row([[checkbox(r[0]), 46, { justify: 'center' }], [frame({ name: 'o', dir: 'V' }, [text(r[1], 'Mono/Default'), text('Placed ' + r[2], 'Caption/Default', 'text/muted')]), 140],
      [[mode, frame({ name: 'w', dir: 'V', sizeH: 'FILL' }, [text(r[3], 'Body/Strong'), text(r[4], win ? 'Caption/Strong' : 'Caption/Default', win ? 'status/attention/fg' : 'text/muted')])], 'fill'],
      [[thumbs(r[5]), text(r[6], 'Body/Small', 'text/secondary')], 150], [text(r[7], 'Body/Default'), 110, { justify: 'end' }],
      [frame({ name: 's', dir: 'V', gap: 'space/1' }, [inst('StatusBadge', { Status: r[8] }), text(r[9], 'Caption/Default', 'text/muted')]), 220], [text(r[10], 'Body/Default', 'text/secondary'), 110],
      [inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default' }), 56, { justify: 'center' }]], r[0], r[8] === 'Needs action', 64);
  })).concat([inst('Pagination', { Range: '1–8 of 34 today' }, { sizeH: 'FILL' })]));
  const bulk = inst('BulkActionBar', {}, { name: 'BulkActionBar' });
  setNested(bulk, 'action-1', prop('Button', 'Label', 'Print packing slips'));
  setNested(bulk, 'action-2', prop('Button', 'Label', 'Message customers'));
  const a3 = bulk.findOne(function (x) { return x.name === 'action-3'; }); a3.setProperties({ Variant: 'Primary' }); a3.setProperties(prop('Button', 'Label', 'Accept 2 orders'));
  const today = frame({ name: 'date', dir: 'H', pad: 14, align: 'center', stroke: 'border/default', sides: ['right'] }, [btn('Today', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'calendar' } })]);
  const strip = kpiStrip([stat('Orders', '34', '↑ 13% vs last Thu', 'Sparkline', true), stat('Items ordered', '97', '↑ 9% vs last Thu', 'Sparkline', true), stat('Cancelled', '1', 'Item unavailable', 'Sparkline', false), stat('Completed', '12', '↑ 2 vs last Thu', 'Sparkline', true), stat('Delivered on time', '98%', 'Target 95% or more', 'Sparkline', false)]);
  strip.children[0].insertChild(0, today);
  return screen('Seller · Orders', 'Seller', 'nav-all-orders', 'Orders', [
    pageTitle('Orders', 'Times shown in your shop’s time zone (Brisbane, AEST)', [btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Open order board', 'Primary')]),
    strip, tableCard, frame({ name: 'bulk-wrap', dir: 'H', justify: 'center', sizeH: 'FILL' }, [bulk]),
  ], { gap: 'space/5' });
}

// ---- Seller · Order board (tablet 1180 × 820)
function tplSellerBoard() {
  const col = function (title, count, bg, border, fg, cards, more) {
    return frame({ name: title, dir: 'V', gap: 'space/2-5', pad: 12, fill: bg, stroke: border, radius: 14, sizeH: 'FILL', sizeV: 'FILL', clip: true }, [
      frame({ name: 'h', dir: 'H', justify: 'between', px: 4, sizeH: 'FILL' }, [text(title, 'Touch/Title', fg), text(count, 'Touch/Title', fg)]),
    ].concat(cards.map(function (v) { return inst('OrderCard', { Variant: v }, { sizeH: 'FILL' }); })).concat(more ? [frame({ name: 'more', dir: 'H', h: 44, justify: 'center', align: 'center', stroke: 'border/input', dash: [3, 3], radius: 'radius/card', sizeH: 'FILL' }, [text(more, 'Touch/Strong', 'text/link')])] : []));
  };
  const board = frame({ name: 'Board', dir: 'H', gap: 14, sizeH: 'FILL', sizeV: 'FILL' }, [
    col('Needs action', '3', 'board/action-bg', 'board/action-border', 'status/attention/fg', ['Urgent', 'Normal']),
    col('Preparing', '5', 'board/prep-bg', 'board/prep-border', 'status/info/fg', ['Preparing'], 'Show 4 more'),
    col('Ready for pickup', '2', 'board/ready-bg', 'board/ready-border', 'status/success/fg', ['Ready']),
  ]);
  const head = frame({ name: 'Board header', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [
    frame({ name: 't', dir: 'H', gap: 'space/3', align: 'center' }, [text('Order board', 'Heading/H1'), inst('Badge', { Tone: 'Success', Leading: 'Dot', Label: 'Live · 2:30 pm' })]),
    frame({ name: 'controls', dir: 'H', gap: 'space/2', align: 'center' }, [
      frame({ name: 'instant', dir: 'H', gap: 'space/2-5', align: 'center', h: 48, px: 12, stroke: 'border/control', radius: 10 }, [inst('Switch', { On: 'True', Size: 'Touch' }), frame({ name: 't', dir: 'V' }, [text('Taking instant orders', 'Body/Strong'), text('until 8:00 pm', 'Caption/Default', 'text/muted')])]),
      btn('Pause 30 min', 'Secondary', 'Touch'), btn('Scheduled · 11', 'Secondary', 'Touch'), inst('IconButton', { Variant: 'Secondary', Size: 'Touch', State: 'Default', Icon: { icon: 'volume' } }),
    ]),
  ]);
  return screen('Seller · Order board (tablet)', 'Seller', 'nav-orders', 'Order board', [head, board], { w: 1180, fixedH: 820, collapsed: true, gap: 'space/4', pad: [18, 20, 0, 20] });
}

// ---------------------------------------------------------------- theme helpers
function colorMaps() {
  const toDark = {}, toLight = {};
  Object.keys(S.color).forEach(function (k) { if (S.colorDark[k]) { toDark[S.color[k].id] = S.colorDark[k]; toLight[S.colorDark[k].id] = S.color[k]; } });
  return { toDark: toDark, toLight: toLight };
}
// Rebind every variable binding in a subtree (paints and numeric fields) through map: variableId → Variable.
const SKIP_FIELDS = { fills: 1, strokes: 1, effects: 1, layoutGrids: 1, componentProperties: 1, textRangeFills: 1 };
function rebindNode(node, map) {
  let n = 0;
  ['fills', 'strokes'].forEach(function (k) {
    if (!(k in node)) return; const arr = node[k]; if (!Array.isArray(arr) || !arr.length) return;
    let changed = false;
    const next = arr.map(function (p) { const b = p.boundVariables && p.boundVariables.color; if (b && map[b.id]) { changed = true; const np = figma.variables.setBoundVariableForPaint(p, 'color', map[b.id]); if (p.opacity !== undefined) np.opacity = p.opacity; return np; } return p; });
    if (changed) { node[k] = next; n++; }
  });
  const bv = node.boundVariables || {};
  Object.keys(bv).forEach(function (field) {
    if (SKIP_FIELDS[field]) return; const b = bv[field];
    if (!b || Array.isArray(b) || !map[b.id]) return;
    try { node.setBoundVariable(field, map[b.id]); n++; } catch (e) { /* field not bindable on this node */ }
  });
  return n;
}
function rebindTree(root, map) {
  const nodes = [root].concat(root.findAll ? root.findAll(function () { return true; }) : []);
  let n = 0; nodes.forEach(function (node) { n += rebindNode(node, map); });
  return n;
}
function applyTheme(node, theme) {
  if (S.modes.color) { node.setExplicitVariableModeForCollection(S.colorModes.collection, theme === 'dark' ? S.colorModes.dark : S.colorModes.light); }
  else rebindTree(node, theme === 'dark' ? colorMaps().toDark : colorMaps().toLight);
  node.setPluginData('theme', theme);
}

// ==== 42_templates_phone.js ====
// ---- Phone templates (360 × 780, release 1.5.0, D16): PhoneTopbar (56 px), bottom tab bar (seller), drawer over a bg/scrim scrim (1.6.0)
function phoneTopbar(ws) { return inst('PhoneTopbar', { Workspace: ws }, { name: 'PhoneTopbar', sizeH: 'FILL' }); } // release 1.6.0: an instance, no longer a loose frame
// 1.8.4: Main scrolls vertically, as the page does on a phone. A list longer than the screen is cut at the bottom on purpose
// (it continues below the fold), and the Audit does not count that as a layer sticking out.
function phoneScreen(name, ws, kids, barActive) {
  const main = frame({ name: 'Main', dir: 'V', gap: 'space/3', pad: 'space/4', sizeH: 'FILL', sizeV: 'FILL', clip: true }, kids);
  main.overflowDirection = 'VERTICAL';
  const parts = [phoneTopbar(ws), main];
  if (barActive) parts.push(inst('BottomTabBar', { Active: barActive, Tabs: '4' }, { name: 'BottomTabBar', sizeH: 'FILL' }));
  const scr = frame({ name: name, dir: 'V', w: 360, h: 780, fill: 'bg/page', clip: true }, parts);
  tag(scr);
  return scr;
}
function withDrawer(scr, ws) {
  add(scr, frame({ name: 'scrim', w: 360, h: 780, fill: 'bg/scrim', abs: [0, 0] }));
  add(scr, inst('NavDrawer', { Workspace: ws }, { name: 'NavDrawer', abs: [0, 0] }));
  return scr;
}
function phoneSellerBody() {
  return [
    frame({ name: 'Page header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text('Good afternoon, Yusuf', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), text('Thursday 1 Oct 2026 · 2:30 pm AEST', 'Body/Default', 'text/muted', { sizeH: 'FILL' })]),
    stageCard('Needs action', '3', 'Oldest waiting 9 min', 3, 'status/attention/solid', true),
    stageCard('Preparing', '5', 'Next ready by 2:48 pm', 5, 'action/primary'),
    frame({ name: 'Order MP-10482', dir: 'V', gap: 'space/2', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
      frame({ name: 'head', dir: 'H', gap: 'space/2', justify: 'between', align: 'center', sizeH: 'FILL' }, [text('MP-10482', 'Mono/Default'), text('Waiting 9 min', 'Caption/Strong', 'status/critical/fg')]),
      text('Lamb cutlets, beef mince, chicken wings', 'Body/Small', 'text/secondary', { sizeH: 'FILL' }),
    ]),
  ];
}
function tplSellerPhoneHome() { return phoneScreen('Seller · Home (phone)', 'Seller', phoneSellerBody(), 'Home'); }
function tplSellerPhoneMenu() { return withDrawer(phoneScreen('Seller · Menu open (phone)', 'Seller', phoneSellerBody(), 'More'), 'Seller'); }
function tplAdminPhoneMenu() {
  const kids = [
    frame({ name: 'Page header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text('Good afternoon, Layla', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), text('35 items waiting for review', 'Body/Default', 'text/muted', { sizeH: 'FILL' })]),
    inst('QueueCard', { Tone: 'Overdue', Title: 'Certifications', Count: '4' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'On track', Title: 'Seller applications', Count: '6', Oldest: 'Oldest 2 days of 3' }, { sizeH: 'FILL' }),
  ];
  return withDrawer(phoneScreen('Admin · Menu open (phone)', 'Admin', kids, null), 'Admin');
}

// ==== 43_templates_auth.js ====
// ---------------------------------------------------------------- release 1.7.0 templates: Auth (A1 to A11) and Seller · Your seller account (S1)
// identity ux.md 3.0, 3.1, 3.2 S1, section 5 (en-AU copy) and 8.1 item 1. Every frame is built from library instances,
// in touch density (3.0 rule 1). Desktop frames are 1280 wide (form column 45% = 576, AuthShowcase 55%); phone frames are
// 360 wide with the form column alone and a space/4 gutter.
const AUTH = {
  Seller: { type: 'Seller account', icon: 'store', panel: 'Seller Centre', email: 'yusuf@kurabyfresh.example', noun: 'seller' },
  Admin: { type: 'Admin account', icon: 'shield-check', panel: 'Admin', email: 'layla.haddad@mondapac.example', noun: 'admin' },
};
const AUTH_SUPPORT = 'Need help? Email support@mondapac.example.';
const AUTH_POLICY = 'Use at least 15 characters. A short sentence works well.';
const AUTH_PRIVACY = 'We collect these details to create and protect your account. Read how we handle them in our privacy policy.';
const AUTH_SEPARATE = 'This is a seller account. It’s separate from any customer account that uses the same email.';

// Touch density for a whole frame: a mode where the plan has modes, otherwise a rebind to "Dimension · Touch".
function applyDensity(node, density) {
  if (S.modes.dim) node.setExplicitVariableModeForCollection(S.dimModes.collection, density === 'touch' ? S.dimModes.touch : S.dimModes.desktop);
  else { const m = pairMaps(S.dim, S.dimTouch); rebindTree(node, density === 'touch' ? m.ab : m.ba); }
  node.setPluginData('density', density);
}
function accountBadge(ws) { return inst('Badge', { Tone: 'Neutral', Leading: 'Icon', Label: AUTH[ws].type, Icon: { icon: AUTH[ws].icon } }, { name: 'account-type' }); }
function authTitle(s) { return text(s, 'Heading/H1', 'text/primary', { name: 'title', sizeH: 'FILL' }); }
function authBody(s) { return text(s, 'Body/Default', 'text/secondary', { name: 'body', sizeH: 'FILL' }); }
function authNote(s, name) { return text(s, 'Body/Small', 'text/muted', { name: name || 'note', sizeH: 'FILL' }); }
function authStep(s) { return text(s, 'Body/Small Strong', 'text/muted', { name: 'step' }); }
function authBanner(tone, title, bodyText) { return inst('InfoBanner', { Tone: tone, Title: title, Body: bodyText, 'Show action': false }, { name: tone === 'Critical' ? 'error-summary' : 'banner', sizeH: 'FILL' }); }
function authField(label, o) {
  o = o || {};
  const props = { Label: label, 'Show helper': !!o.helper, 'Show error': !!o.error };
  if (o.helper) props.Helper = o.helper;
  if (o.error) props.Error = o.error;
  const f = inst('Field', props, { name: 'field-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), sizeH: 'FILL' });
  const type = o.type || 'Text';
  const state = o.error ? 'Error' : (o.state || ((type === 'Text' ? o.value : o.filled) ? 'Filled' : 'Default'));
  const ctl = Object.assign({ Type: type, State: state }, prop('Input', 'Leading icon', type !== 'Text'));
  if (type === 'Text') Object.assign(ctl, prop('Input', 'Value', o.value || ''));
  setNested(f, 'control', ctl);
  return f;
}
function authPrimary(label, state) { return inst('Button', { Variant: 'Primary', Size: 'Touch', State: state || 'Default', Label: label }, { name: 'primary-action', sizeH: 'FILL' }); }
function authSecondary(label, iconName, fill) { return inst('Button', { Variant: 'Secondary', Size: 'Touch', State: 'Default', Label: label, 'Leading icon': !!iconName, Icon: { icon: iconName || 'plus' } }, { name: 'secondary-action', sizeH: fill ? 'FILL' : null }); }
function authLinks(labels) { return frame({ name: 'links', dir: 'V', align: 'start' }, labels.filter(Boolean).map(function (l) { return inst('Button', { Variant: 'Link', Size: 'Touch', State: 'Default', Label: l }, { name: 'link' }); })); }
function authCheck(label, help) {
  return frame({ name: 'checkbox-row', dir: 'H', gap: 'space/2-5', align: 'start', sizeH: 'FILL' }, [
    frame({ name: 'box', dir: 'H', pad: [2, 0, 0, 0] }, [inst('Checkbox', { Value: 'Unchecked', State: 'Default' })]),
    frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(label, 'Touch/Body', 'text/primary', { name: 'label', sizeH: 'FILL' }), help ? authNote(help, 'help') : null]),
  ]);
}
function mailTile() { return frame({ name: 'mail-icon', dir: 'H', w: 48, h: 48, align: 'center', justify: 'center', fill: 'bg/selected', radius: 'radius/pill' }, [icon('mail', 'text/link', 24)]); }
// QR placeholder on its white plate (bg/qr). The modules use bg/auth-showcase-admin, the only token that stays dark in both
// themes; the real code is drawn by the frontend in black on bg/qr.
function qrPlate() {
  const M = 6, Q = 25, N = 21;
  const plate = frame({ name: 'qr-code', w: 176, h: 176, fill: 'bg/qr', stroke: 'border/default', radius: 'radius/control' });
  const finder = function (cx, cy) {
    add(plate, rect({ name: 'finder', w: 7 * M, h: 7 * M, fill: 'bg/auth-showcase-admin', xy: [Q + cx * M, Q + cy * M] }));
    add(plate, rect({ name: 'finder-gap', w: 5 * M, h: 5 * M, fill: 'bg/qr', xy: [Q + (cx + 1) * M, Q + (cy + 1) * M] }));
    add(plate, rect({ name: 'finder-eye', w: 3 * M, h: 3 * M, fill: 'bg/auth-showcase-admin', xy: [Q + (cx + 2) * M, Q + (cy + 2) * M] }));
  };
  finder(0, 0); finder(14, 0); finder(0, 14);
  const cells = []; let seed = 7;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if ((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)) continue;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    if (seed % 100 < 46) { const px = Q + x * M, py = Q + y * M; cells.push('M ' + px + ' ' + py + ' L ' + (px + M) + ' ' + py + ' L ' + (px + M) + ' ' + (py + M) + ' L ' + px + ' ' + (py + M) + ' Z'); }
  }
  add(plate, vector({ name: 'modules', d: cells.join(' '), fill: 'bg/auth-showcase-admin', closed: true }));
  return plate;
}
function keyRow() {
  return frame({ name: 'setup-key', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [
    frame({ name: 'key', dir: 'H', h: 'size/control', px: 'space/3', align: 'center', fill: 'bg/subtle', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [text('JBSW Y3DP EHPK 3PXP', 'Mono/Default', 'text/primary', { name: 'key-text' })]),
    authSecondary('Copy', 'copy'),
  ]);
}
const BACKUP_CODES = ['K7Q2M 9XW4P', '3HJ8R T6V2C', 'W5N9D 4QK7M', 'P2X6F 8RJ3T', 'C9M4V 7HW2K', 'T3K8P 5NX9D', 'F6R2W 3JC8V', 'M8V5H 2TP6Q', 'X4D7K 9MF3R', 'J2W9T 6CV4H'];
function backupCodes() {
  const col = function (list, n) { return frame({ name: 'column-' + n, dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, list.map(function (c) { return text(c, 'Mono/Default', 'text/primary'); })); };
  return frame({ name: 'backup-codes', dir: 'H', gap: 'space/6', pad: 'space/4', fill: 'bg/subtle', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [col(BACKUP_CODES.slice(0, 5), 1), col(BACKUP_CODES.slice(5), 2)]);
}

// ---- the frame: form column (bg/surface, 45%, at least 480) + AuthShowcase (55%); phone: the form column alone
function authFrame(name, ws, kids, phone) {
  const content = frame({ name: 'content', dir: 'V', gap: 'space/5', w: phone ? undefined : 'size/auth-card', sizeH: phone ? 'FILL' : null }, kids);
  const header = frame({ name: 'header', dir: 'H', sizeH: 'FILL' }, [inst('BrandMark', { Panel: AUTH[ws].panel }, { name: 'brand-mark' })]);
  const footer = frame({ name: 'footer', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text('MondaPac Australia', 'Caption/Strong', 'text/secondary', { name: 'market' }), text(AUTH_SUPPORT, 'Caption/Default', 'text/muted', { name: 'support', sizeH: 'FILL' })]);
  const form = frame({ name: 'Form column', dir: 'V', gap: 'auto', align: 'center', pad: phone ? [24, 16, 24, 16] : [32, 48, 32, 48], fill: 'bg/surface', w: phone ? undefined : 576, minW: phone ? undefined : 480, sizeH: phone ? 'FILL' : null, sizeV: 'FILL' }, [header, content, footer]);
  const parts = phone ? [form] : [form, inst('AuthShowcase', { Workspace: ws }, { name: 'AuthShowcase', sizeH: 'FILL', sizeV: 'FILL' })];
  const scr = frame({ name: name, dir: 'H', w: phone ? 360 : 1280, h: phone ? 780 : 900, fill: 'bg/surface', clip: true }, parts);
  applyDensity(scr, 'touch');
  tag(scr);
  return scr;
}

// ---- screens: each returns the content column's children
function authA1(ws, state) {
  const seller = ws === 'Seller';
  let banner = null;
  if (state === 'Error') banner = authBanner('Critical', 'Email or password is incorrect.', 'Check both and try again.');
  if (state === 'Throttled') banner = authBanner('Critical', 'Too many attempts.', 'Try again in 15 minutes. You can still reset your password.');
  if (state === 'Two-step paused') banner = authBanner('Critical', 'Too many wrong codes.', 'Two-step sign-in is paused for 24 hours. Reset your password to try again sooner.');
  if (state === 'Session ended') banner = authBanner('Info', 'Your session has ended.', 'Sign in again to continue.');
  return [
    accountBadge(ws), authTitle('Sign in to your ' + AUTH[ws].noun + ' account'), banner,
    authField('Email', { value: AUTH[ws].email }),
    authField('Password', { type: 'Password', filled: !state || state === 'Session ended' }),
    seller ? authCheck('Keep me signed in on this device', 'Only on a device you don’t share. You stay signed in for up to 30 days.') : null,
    authPrimary('Sign in', state === 'Throttled' ? 'Disabled' : 'Default'),
    authLinks(['Forgot password?', seller ? 'New to MondaPac? Create a seller account' : null]),
    seller ? authNote('Seller and customer accounts are separate. Each has its own password.') : null,
  ];
}
function authA2() {
  return [accountBadge('Seller'), authTitle('Create a seller account'), authBody('First confirm your email. Then MondaPac reviews your application before you can sell.'),
    authField('Your name', { value: 'Yusuf Karimi' }), authField('Email', { value: AUTH.Seller.email }), authField('Password', { type: 'Password', filled: true, helper: AUTH_POLICY }),
    authPrimary('Create account'), authNote(AUTH_PRIVACY, 'privacy-notice'), authLinks(['Already have a seller account? Sign in'])];
}
function authA3(ws) {
  const admin = ws === 'Admin';
  return [accountBadge(ws), mailTile(), authTitle('Check your email'),
    authBody(admin ? 'Your two-step verification was reset. We’ve sent a link to ' + AUTH.Admin.email + ' to set it up again. The link works for 60 minutes.' : 'We’ve sent an email to ' + AUTH.Seller.email + '. Open it and follow the link to continue.'),
    authNote('It can take a few minutes. Check your spam folder too.'), authSecondary('Send it again', 'send'),
    authLinks([admin ? null : 'Wrong address? Sign up again', 'Back to sign in'])];
}
function authA4(state) {
  if (state === 'Not usable') return [accountBadge('Seller'), authTitle('This link can’t be used'), authBody('It may have expired or already been used. Enter your email and we’ll send a new one.'), authField('Email', { value: AUTH.Seller.email }), authPrimary('Send a new link'), authLinks(['Back to sign in'])];
  return [accountBadge('Seller'), authTitle('Confirm your email'), authBody('Enter your password to confirm your email. Then you’ll see the status of your application.'), authField('Password', { type: 'Password', filled: true }), authPrimary('Confirm email')];
}
function authA5(ws, state) {
  if (state === 'Sent') return [accountBadge(ws), mailTile(), authTitle('Check your email'), authBody('If ' + (ws === 'Admin' ? 'an admin' : 'a seller') + ' account uses ' + AUTH[ws].email + ', we’ve sent a link to reset its password. The link works for 60 minutes.'), authLinks(['Back to sign in'])];
  return [accountBadge(ws), authTitle('Reset your ' + AUTH[ws].noun + ' account password'), authField('Email', { value: AUTH[ws].email }), authPrimary('Send reset link'), authLinks(['Back to sign in'])];
}
function authA6(ws) {
  return [accountBadge(ws), authTitle('Choose a new password'), authBody('Changing your password signs you out everywhere.'), authField('New password', { type: 'Password', filled: true, helper: AUTH_POLICY }), authPrimary('Save new password')];
}
function authA7(ws, state) {
  const help = ws === 'Admin' ? 'No phone and no backup codes? Ask another admin who manages admin accounts to reset it.' : 'No phone and no backup codes? Email support@mondapac.example from the address you sign in with.';
  const backup = state === 'Backup code';
  return [accountBadge(ws), authTitle(backup ? 'Enter a backup code' : 'Enter your 6-digit code'), authBody(backup ? 'Each backup code works once.' : 'Open your authenticator app and enter the code for MondaPac.'),
    authField(backup ? 'Backup code' : '6-digit code', { type: 'Code', filled: !backup }), authPrimary('Verify'),
    authLinks([backup ? 'Use your authenticator app instead' : 'Use a backup code instead', 'Can’t use either?']), authNote(help, 'help')];
}
// Two-step set-up steps. step: 'password' | 'scan' | 'code' | 'codes'; label like "Step 2 of 4"; cancel: seller set-up before the code is accepted.
function authSetupStep(ws, step, label, o) {
  o = o || {};
  const kids = [accountBadge(ws), authStep(label)];
  if (step === 'password') return kids.concat([authTitle(o.again ? 'Set up two-step verification again' : 'Set up two-step verification'), authBody('Enter your password to continue.'), ws === 'Admin' ? authNote('Admin accounts must use two-step verification.', 'required') : null, authField('Password', { type: 'Password', filled: true }), authPrimary('Continue'), o.cancel ? authLinks(['Cancel']) : null]);
  if (step === 'scan') return kids.concat([authTitle('Set up two-step verification'), ws === 'Admin' ? authNote('Admin accounts must use two-step verification.', 'required') : null, authBody('Scan this code with an authenticator app on your phone.'), qrPlate(), authNote('Can’t scan it? Enter this key in the app instead.', 'manual'), keyRow(), authSecondary('Open authenticator app', 'smartphone', true), authPrimary('Continue'), o.cancel ? authLinks(['Cancel']) : null]);
  if (step === 'code') return kids.concat([authTitle('Set up two-step verification'), authBody('Enter the 6-digit code the app shows.'), authField('6-digit code', { type: 'Code', filled: true }), authPrimary('Verify'), o.cancel ? authLinks(['Cancel']) : null]);
  return kids.concat([authTitle('Save your backup codes'), authBody('If you lose your phone, a backup code lets you sign in. Each code works once. We can’t show them again.'), backupCodes(),
    frame({ name: 'code-actions', dir: 'H', gap: 'space/2' }, [authSecondary('Copy', 'copy'), authSecondary('Download', 'download'), authSecondary('Print', 'printer')]),
    authCheck('I’ve saved these codes'), authPrimary('Continue', 'Disabled')]);
}
function authA9(ws, variant) {
  if (variant === 'Not usable') return [accountBadge(ws), authTitle('This invitation can’t be used'), authBody('Ask the person who invited you to send a new one.'), authLinks(['Back to sign in'])];
  const email = authField('Email', { value: variant === 'Admin' ? 'omar.saleh@mondapac.example' : (variant === 'Team member' ? 'amina.rahman@kurabyfresh.example' : AUTH.Seller.email), state: 'Disabled', helper: 'You’ll sign in with this email.' });
  const pw = authField('Password', { type: 'Password', filled: true, helper: AUTH_POLICY });
  if (variant === 'Admin') return [accountBadge(ws), authTitle('Set up your admin account'), authBody('You’ve been invited to be a MondaPac admin with the role Seller reviewer. Enter your name and choose a password, then set up two-step verification.'), email, authField('Your name', { value: 'Omar Saleh' }), pw, authNote(AUTH_PRIVACY, 'privacy-notice'), authPrimary('Accept and continue')];
  if (variant === 'Team member') return [accountBadge(ws), authTitle('Join a seller team on MondaPac'), authBody('Yusuf Karimi invited you to join as Order packer. Enter your name and choose a password to accept.'), email, authField('Your name', { value: 'Amina Rahman' }), pw, authNote(AUTH_SEPARATE, 'separate'), authNote(AUTH_PRIVACY, 'privacy-notice'), authPrimary('Accept and continue')];
  return [accountBadge(ws), authTitle('Set up your seller account'), authBody('MondaPac has created a seller account for you. Choose a password to get started.'), email, pw, authNote(AUTH_SEPARATE, 'separate'), authNote(AUTH_PRIVACY, 'privacy-notice'), authPrimary('Accept and continue')];
}
function authA10(variant) {
  const owner = variant === 'Owner';
  return [accountBadge('Seller'), authBanner('Critical', 'This seller account is suspended', owner ? 'Nobody on your team can sign in while it’s suspended. The reason is below.' : 'Nobody on the team can sign in while it’s suspended. Ask your shop owner for details.'),
    owner ? inst('ReasonQuote', { Reason: 'Your Halal certificate expired on 30 Sep 2026 and no renewal was uploaded. Upload a current certificate, then contact us to lift the suspension.', Date: 'Written on 6 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }) : null,
    authLinks(['Back to sign in'])];
}
function authA11() {
  return [accountBadge('Seller'), authTitle('Turn off two-step verification?'), authBody('A MondaPac admin started this after a request to support. You’ll be signed out everywhere and sign in with your password only, until you set it up again.'), authPrimary('Turn off two-step verification'), authNote('Didn’t ask for this? Close this page and change your password.', 'help')];
}

// Every Auth frame: [row, name, make]. "Update library" builds only the names a file does not have yet.
function authScreens() {
  const L = [];
  const add2 = function (row, ws, id, state, make, phone) {
    const name = 'Auth · ' + ws + ' · ' + id + (state ? ' · ' + state : '') + (phone ? ' (phone)' : '');
    L.push([row, name, function () { return authFrame(name, ws, make(), phone); }]);
  };
  [null, 'Error', 'Throttled', 'Two-step paused', 'Session ended'].forEach(function (s) { add2('Seller', 'Seller', 'A1 Sign in', s, function () { return authA1('Seller', s); }); });
  add2('Seller', 'Seller', 'A2 Sign up', null, authA2);
  add2('Seller', 'Seller', 'A3 Check your email', null, function () { return authA3('Seller'); });
  add2('Seller', 'Seller', 'A4 Confirm your email', null, function () { return authA4(null); });
  add2('Seller', 'Seller', 'A4 Confirm your email', 'Not usable', function () { return authA4('Not usable'); });
  add2('Seller', 'Seller', 'A5 Forgot password', null, function () { return authA5('Seller', null); });
  add2('Seller', 'Seller', 'A5 Forgot password', 'Sent', function () { return authA5('Seller', 'Sent'); });
  add2('Seller', 'Seller', 'A6 Choose a new password', null, function () { return authA6('Seller'); });
  add2('Seller', 'Seller', 'A7 Two-step verification', null, function () { return authA7('Seller', null); });
  add2('Seller', 'Seller', 'A7 Two-step verification', 'Backup code', function () { return authA7('Seller', 'Backup code'); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 1 of 4', function () { return authSetupStep('Seller', 'password', 'Step 1 of 4', { cancel: true }); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 2 of 4', function () { return authSetupStep('Seller', 'scan', 'Step 2 of 4', { cancel: true }); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 3 of 4', function () { return authSetupStep('Seller', 'code', 'Step 3 of 4', { cancel: true }); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 4 of 4', function () { return authSetupStep('Seller', 'codes', 'Step 4 of 4'); });
  add2('Seller', 'Seller', 'A9 Accept invitation', 'Seller created by admin', function () { return authA9('Seller', 'Seller'); });
  add2('Seller', 'Seller', 'A9 Accept invitation', 'Team member', function () { return authA9('Seller', 'Team member'); });
  add2('Seller', 'Seller', 'A9 Accept invitation', 'Not usable', function () { return authA9('Seller', 'Not usable'); });
  add2('Seller', 'Seller', 'A10 Account suspended', 'Owner', function () { return authA10('Owner'); });
  add2('Seller', 'Seller', 'A10 Account suspended', 'Staff', function () { return authA10('Staff'); });
  add2('Seller', 'Seller', 'A11 Turn off two-step verification', null, authA11);
  [null, 'Error', 'Throttled', 'Two-step paused', 'Session ended'].forEach(function (s) { add2('Admin', 'Admin', 'A1 Sign in', s, function () { return authA1('Admin', s); }); });
  add2('Admin', 'Admin', 'A3 Check your email', 'Two-step reset', function () { return authA3('Admin'); });
  add2('Admin', 'Admin', 'A5 Forgot password', null, function () { return authA5('Admin', null); });
  add2('Admin', 'Admin', 'A5 Forgot password', 'Sent', function () { return authA5('Admin', 'Sent'); });
  add2('Admin', 'Admin', 'A6 Choose a new password', null, function () { return authA6('Admin'); });
  add2('Admin', 'Admin', 'A7 Two-step verification', null, function () { return authA7('Admin', null); });
  add2('Admin', 'Admin', 'A7 Two-step verification', 'Backup code', function () { return authA7('Admin', 'Backup code'); });
  add2('Admin', 'Admin', 'A8 Set up two-step again', 'Step 1 of 4', function () { return authSetupStep('Admin', 'password', 'Step 1 of 4', { again: true }); });
  add2('Admin', 'Admin', 'A9 Accept invitation', null, function () { return authA9('Admin', 'Admin'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Step 1 of 3', function () { return authSetupStep('Admin', 'scan', 'Step 1 of 3'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Step 2 of 3', function () { return authSetupStep('Admin', 'code', 'Step 2 of 3'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Step 3 of 3', function () { return authSetupStep('Admin', 'codes', 'Step 3 of 3'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Not usable', function () { return authA9('Admin', 'Not usable'); });
  ['Seller', 'Admin'].forEach(function (ws) {
    add2('Phone', ws, 'A1 Sign in', null, function () { return authA1(ws, null); }, true);
    add2('Phone', ws, 'A7 Two-step verification', null, function () { return authA7(ws, null); }, true);
  });
  return L;
}
// names: only these frames (Update library); otherwise all of them.
function buildAuthFrames(names) {
  const out = [];
  authScreens().forEach(function (d) { if (names && names.indexOf(d[1]) < 0) return; out.push({ row: d[0], frame: d[2]() }); });
  return out;
}
function authFrameNames() { return authScreens().map(function (d) { return d[1]; }); }

// ---- Seller · Your seller account (S1): the landing page while the seller is not approved, in the limited shell
const S1_STATES = { 'Awaiting approval': ['Info', 'clock', 'Info', 'We’re reviewing your application', 'We’ll email you when there’s a decision. Until then you can’t sell or use the rest of the seller panel.', 'Waiting', 'In progress'],
  'Changes needed': ['Attention', 'alert-circle', 'Attention', 'Your application needs changes', 'Read the reason below, then contact us to continue.', 'Needs attention', 'Needs changes'],
  'Not approved': ['Critical', 'x', 'Critical', 'Your application wasn’t approved', 'You’ve reached the limit for new applications. Contact us if you have questions.', 'Needs attention', 'Not approved'] };
function s1Content(state) {
  const st = S1_STATES[state];
  const step = function (s, title, by) { return inst('ChecklistItem', { State: s, Title: title, By: by, 'Show actions': false }, { name: 'step', sizeH: 'FILL' }); };
  const slot = frame({ name: 'phase-3-slot', dir: 'H', pad: [12, 18, 12, 18], sizeH: 'FILL', stroke: 'border/row', sides: ['top'] }, [
    frame({ name: 'slot', dir: 'H', px: 'space/3', py: 'space/2', stroke: 'border/input', dash: [4, 4], radius: 'radius/control', sizeH: 'FILL' }, [text('Slot for the steps the sellers module adds in Phase 3', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
  ]);
  return [
    frame({ name: 'Page header', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [text('Your seller account', 'Heading/H1'), inst('Badge', { Tone: st[0], Leading: 'Icon', Label: state, Icon: { icon: st[1] } }, { name: 'status' })]),
    authBanner(st[2], st[3], st[4]),
    state === 'Changes needed' ? inst('ReasonQuote', { Reason: 'The business name on your application doesn’t match the name registered for your ABN. Send us the registered name or the correct ABN, then contact us to continue.', Date: 'Written on 6 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }) : null,
    card('Steps', [step('Done', 'Account created', '3 Oct 2026'), step('Done', 'Email confirmed', '3 Oct 2026'), slot, step(st[5], 'MondaPac reviews your application', st[6])]),
    card('Help', [frame({ name: 'help', dir: 'V', gap: 'space/3', pad: [16, 18, 16, 18], sizeH: 'FILL' }, [text('Protect your account', 'Heading/H2'), text('Turn on two-step verification while you wait.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }), btn('Set up two-step verification', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'smartphone' } }), text(AUTH_SUPPORT, 'Body/Small', 'text/muted', { name: 'support', sizeH: 'FILL' })])]),
  ];
}
function limitedSidebar() {
  const sb = inst('Sidebar', { Workspace: 'Seller', Collapsed: 'False' }, { name: 'Sidebar', sizeV: 'FILL' });
  const keep = { 'nav-home': 1, 'nav-settings': 1 };
  const items = sb.findOne(function (n) { return n.name === 'items'; });
  items.children.forEach(function (n) { if (!keep[n.name]) n.visible = false; });
  const sw = sb.findOne(function (n) { return n.name === 'shop-switcher'; }); if (sw) sw.visible = false;
  setNested(sb, 'nav-home', Object.assign(prop('NavItem', 'Label', 'Your seller account'), prop('NavItem', 'Icon', S.icons.store.id)));
  setNested(sb, 'nav-settings', Object.assign(prop('NavItem', 'Label', 'Account security'), prop('NavItem', 'Icon', S.icons.lock.id)));
  return sb;
}
function s1Name(state, phone) { return 'Seller · Your seller account · ' + state + (phone ? ' (phone)' : ''); }
function tplSellerAccount(state, menuOpen) {
  const col = frame({ name: 'Column', dir: 'V', sizeH: 'FILL' }, [
    inst('Topbar', { Workspace: 'Seller', Crumb: 'Your seller account', 'Show search': false, 'Show notifications': false }, { name: 'Topbar', sizeH: 'FILL' }),
    frame({ name: 'Main', dir: 'V', pad: [28, 32, 40, 32], sizeH: 'FILL' }, [frame({ name: 'content', dir: 'V', gap: 'space/5', w: 760 }, s1Content(state))]),
  ]);
  const scr = frame({ name: s1Name(state), dir: 'H', w: 1440, fill: 'bg/page', clip: true }, [limitedSidebar(), col]);
  if (menuOpen) add(scr, inst('Menu', {}, { name: 'Account menu (open)', abs: [1440 - 280 - 24, 60] }));
  tag(scr);
  return scr;
}
function tplSellerAccountPhone(state) {
  const scr = phoneScreen(s1Name(state, true), 'Seller', s1Content(state), null);
  const bar = scr.children[0];
  ['menu-button', 'notifications'].forEach(function (n) { const x = bar.findOne(function (k) { return k.name === n; }); if (x) x.visible = false; });
  return scr;
}
// S1 frames: [name, make]. The awaiting frame shows the account menu open (sign out lives there).
function s1Screens() {
  return [[s1Name('Awaiting approval'), function () { return tplSellerAccount('Awaiting approval', true); }], [s1Name('Changes needed'), function () { return tplSellerAccount('Changes needed'); }],
    [s1Name('Not approved'), function () { return tplSellerAccount('Not approved'); }], [s1Name('Awaiting approval', true), function () { return tplSellerAccountPhone('Awaiting approval'); }]];
}
// Dark preview copies added in 1.7.0 (sources by name).
const DARK_170 = ['Auth · Seller · A1 Sign in', 'Auth · Admin · A1 Sign in', s1Name('Changes needed')];

// Rows of frames under a header: Seller, Admin, then phone frames.
function rowsPage(host, title, subtitle, rows) {
  const head = frame({ name: title, dir: 'V', gap: 'space/3', w: 1200 }, [text('MondaPac Design System', 'Caption/Overline', 'text/link'), text(title, 'Display/Hero'), para(subtitle, 1100)]);
  head.fills = []; host.appendChild(head); head.x = 0; head.y = 0; tag(head);
  placeRows(host, rows, 240);
}
// 1.8.1: rows are stacked from the sizes read AFTER every frame is in the host and positioned (a hugging frame's height is final only then),
// never from a size read while the frame was being built. `y` must come from bottomEdge() of what the host already holds.
function placeRows(host, rows, y) {
  const live = rows.filter(function (r) { return r.length; });
  live.forEach(function (r) { r.forEach(function (s) { host.appendChild(s); }); });
  live.forEach(function (r) {
    let x = 0, bottom = y;
    r.forEach(function (s) { s.x = x; s.y = y; x += s.width + 160; });
    r.forEach(function (s) { bottom = Math.max(bottom, s.y + s.height); });
    y = bottom + 240;
  });
  return y;
}
const AUTH_SUBTITLE = 'Sign-in and account screens before the panel (identity ux.md 3.1), A1 to A11, for Seller and Admin. 1280 wide: the form column (bg/surface, 45%, at least 480) and AuthShowcase; 360 wide: the form column alone. Touch density at every width. Copy is the en-AU text of ux.md section 5; names and emails are examples.';

// ==== 44_templates_panel.js ====
// ---------------------------------------------------------------- release 1.8.0 templates: Members, Roles, No access, Not found, Account security and the dialogs D1 to D3
// Spec: figma-1.2.0-spec.md (renumbered 1.8.0) section 3 and identity ux.md section 5 (en-AU copy). Names, emails and role names are
// examples (the ready-made role set is not approved yet, DD 14.4). Admin frames go to Templates · Admin, Seller frames to Templates · Seller.
// Not in 1.8.0 (they are 1.8.3, 45_templates_panel_183.js): the Sellers list (P1), the role editor (B3), dialogs D4 to D6 and the unsaved-changes dialog.
// No Sidebar item is active on these pages: the nav-config release adds "Team & roles" (seller) and "Roles & permissions" (admin).
const VIEW_ONLY = 'Your role can view people and roles but not change them.';
const NOT_HELD = 'You can’t give a permission you don’t have.';
const PANEL_BODIES = []; // template-body components made in the current run, placed under the frames by addPanelTemplates

// ---- small parts
function bdg(tone, leading, label, ic) { const p = { Tone: tone, Leading: leading, Label: label }; if (leading === 'Icon') p.Icon = { icon: ic }; return inst('Badge', p); }
const STATUS_BADGE = { Active: ['Success', 'Dot', 'Active'], Invited: ['Neutral', 'Icon', 'Invited', 'send'], Deactivated: ['Neutral', 'Icon', 'Deactivated', 'ban'], 'Invitation expired': ['Attention', 'Icon', 'Invitation expired', 'clock'], On: ['Success', 'Icon', 'On', 'check'], Off: ['Neutral', 'Icon', 'Off', 'x'] };
function statusBadge(k) { const d = STATUS_BADGE[k]; return bdg(d[0], d[1], d[2], d[3]); }
const TYPE_BADGE = { System: ['Neutral', 'Icon', 'System', 'lock'], Owner: ['Neutral', 'Icon', 'Owner', 'lock'], Default: ['Neutral', 'None', 'Default'], 'Ready-made': ['Neutral', 'None', 'Ready-made'], Custom: ['Info', 'None', 'Custom'] };
function typeBadge(k) { const d = TYPE_BADGE[k]; return bdg(d[0], d[1], d[2], d[3]); }
function rowAction(touch) { return inst('IconButton', { Variant: 'Ghost', Size: touch ? 'Touch' : 'Sm', State: 'Default' }, { name: 'row-actions' }); }
function tabsBar(list) {
  return frame({ name: 'tabs', dir: 'H', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, list.map(function (t) {
    const p = { Selected: t[2] ? 'True' : 'False', Label: t[0], 'Show count': t[1] !== null }; if (t[1] !== null) p.Count = t[1];
    return inst('Tab', p);
  }));
}
function personCell(m, touch) {
  const nameRow = frame({ name: 'name-row', dir: 'H', gap: 'space/2', align: 'center' }, [text(m.name, 'Body/Strong'), m.you ? bdg('Neutral', 'None', 'You') : null]);
  return [inst('IdentityTile', { Tone: m.tone, Shape: 'Circle', Initials: m.i }), frame({ name: 'person', dir: 'V', sizeH: 'FILL' }, [nameRow, text(m.email, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })])];
}
function roleNodes(m) { return m.system ? [icon('lock', 'icon/muted', 14), text(m.role, 'Body/Default')] : [text(m.role, 'Body/Default')]; }
function loadingRows(cols) {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push(frame({ name: 'Row', dir: 'H', sizeH: 'FILL' }, cols.map(function (c) {
      const t = inst('TableCell', { Type: c[0], State: 'Loading' }, { name: 'skeleton ' + c[0], sizeH: c[1] === 'fill' ? 'FILL' : null });
      if (c[1] !== 'fill') t.resize(c[1], t.height);
      return t;
    })));
  }
  return rows;
}
function groupRow(label) { return frame({ name: 'Group · ' + label, dir: 'H', px: 'space/3', py: 'space/2', fill: 'bg/subtle', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [text(label, 'Caption/Overline', 'text/muted')]); }
function panelBanner(title, bodyText) { return inst('InfoBanner', { Tone: 'Info', Title: title, Body: bodyText, 'Show action': false }, { name: 'banner', sizeH: 'FILL' }); }
function menuItemProps(state, label, ic, desc, leading) {
  const p = Object.assign({ State: state }, prop('MenuItem', 'Label', label), prop('MenuItem', 'Leading icon', leading !== false), prop('MenuItem', 'Show description', !!desc));
  if (ic) Object.assign(p, prop('MenuItem', 'Icon', S.icons[ic].id));
  if (desc) Object.assign(p, prop('MenuItem', 'Description', desc));
  return p;
}
// A row actions menu (no header): items = [state, label, icon, description] for item-1 to item-3.
function rowMenu(items, abs, w) {
  const m = inst('Menu', { 'Show header': false, 'Show divider': false }, { name: 'Row menu (open)', abs: abs, w: w });
  ['item-1', 'item-2', 'item-3'].forEach(function (n, i) { setNested(m, n, menuItemProps(items[i][0], items[i][1], items[i][2], items[i][3])); });
  return m;
}
// 1.8.1: Panel desktop pages hug their content but are at least this high (the Sidebar is FILL; on a short page its items would stick out).
const PANEL_MIN_H = 900;
function shellPage(name, ws, crumb, kids, o) { return screen(name, ws, 'none', crumb, kids, Object.assign({ minH: PANEL_MIN_H }, o)); }
function primaryHeaderButton(label, state) { return btn(label, 'Primary', 'Md', { State: state || 'Default', 'Leading icon': true, Icon: { icon: 'plus' } }); }
function fullButton(label, variant, state) { return inst('Button', { Variant: variant || 'Primary', Size: 'Touch', State: state || 'Default', Label: label }, { name: 'primary-action', sizeH: 'FILL' }); }

// A row menu with two items (item-1 and item-3; Show item 2 off): the actions of an invitation row.
function invitationMenu(abs) {
  const m = inst('Menu', { 'Show header': false, 'Show item 2': false, 'Show divider': false }, { name: 'Row menu (open)', abs: abs });
  setNested(m, 'item-1', menuItemProps('Default', 'Resend invitation', 'send'));
  setNested(m, 'item-3', menuItemProps('Destructive', 'Cancel invitation…', 'x'));
  return m;
}

// ---- Members (T8, B1)
const ADMIN_MEMBERS = [
  { i: 'LH', tone: 'Teal', name: 'Layla Haddad', email: 'layla.haddad@mondapac.example', you: true, role: 'Compliance lead', status: 'Active' },
  { i: 'OS', tone: 'Blue', name: 'Omar Saleh', email: 'omar.saleh@mondapac.example', role: 'Platform owner', system: true, status: 'Active' },
  { i: 'AS', tone: 'Amber', name: 'Amira Said', email: 'amira.said@mondapac.example', role: 'Finance reviewer', status: 'Active' },
  { i: 'NH', tone: 'Purple', name: 'Noor Hassan', email: 'noor.hassan@mondapac.example', role: 'Seller reviewer', status: 'Invited' },
  { i: 'SO', tone: 'Neutral', name: 'Sam Okafor', email: 'sam.okafor@mondapac.example', role: 'Support agent', status: 'Deactivated' },
];
// 1.10.1: an invitation past the expiry of its last mail (identity API status `expired`); it can still be re-sent or cancelled. Shown on its own frame.
const INVITATION_EXPIRED = 'Invitation expired';
const ADMIN_EXPIRED = { i: 'KA', tone: 'Amber', name: 'Karim Aziz', email: 'karim.aziz@mondapac.example', role: 'Support agent', status: INVITATION_EXPIRED };
const SELLER_MEMBERS = [
  { i: 'YK', tone: 'Teal', name: 'Yusuf Karimi', email: 'yusuf@kurabyfresh.example', you: true, role: 'Owner', system: true, two: 'On', status: 'Active' },
  { i: 'AR', tone: 'Amber', name: 'Amina Rahman', email: 'amina.rahman@kurabyfresh.example', role: 'Order packer', two: 'Off', status: 'Active' },
  { i: 'TN', tone: 'Blue', name: 'Tariq Nasser', email: 'tariq.nasser@kurabyfresh.example', role: 'Order packer', two: null, status: 'Invited' },
];
// A list that cannot load is an InfoBanner Critical with "Try again", not an empty state (title: identity.error.list-load.title, body: identity.error.network).
function listLoadError() { return inst('InfoBanner', { Tone: 'Critical', Title: 'We couldn’t load this list', Body: 'You’re offline or the connection dropped. Check it and try again.', 'Show action': true, Action: 'Try again' }, { name: 'load-error', sizeH: 'FILL' }); }
function membersTable(ws, state, extra) {
  const admin = ws === 'Admin';
  const cols = admin ? [['Person', 'fill'], ['Role', 220], ['Status', 170], ['', 56]] : [['Person', 'fill'], ['Role', 200], ['Two-step verification', 200], ['Status', 150], ['', 56]];
  if (state === 'Load error') return listLoadError();
  const kids = [headerRow(cols)];
  if (state === 'Loading') return card('Member list', kids.concat(loadingRows(admin ? [['Two-line', 'fill'], ['Text', 220], ['Text', 170], ['Actions', 56]] : [['Two-line', 'fill'], ['Text', 200], ['Text', 200], ['Text', 150], ['Actions', 56]])));
  if (state === 'Empty') return card('Member list', kids.concat([inst('EmptyState', { Size: 'Card', Icon: { icon: 'users' }, Title: 'It’s just you so far', Body: 'Invite the people who help run your shop. Each person gets their own sign-in.' }, { name: 'empty-state', sizeH: 'FILL' })]));
  (admin ? ADMIN_MEMBERS : SELLER_MEMBERS).concat(extra || []).forEach(function (m) {
    const cells = [[personCell(m), 'fill'], [roleNodes(m), admin ? 220 : 200, { gap: 'space/1-5' }]];
    if (!admin) cells.push([m.two ? statusBadge(m.two) : null, 200]);
    cells.push([statusBadge(m.status), admin ? 170 : 150], [rowAction(), 56, { justify: 'center' }]);
    kids.push(row(cells, false, false, 64));
  });
  return card('Member list', kids);
}
function tplMembersAdmin(state) {
  const view = state === 'View only', expired = state === INVITATION_EXPIRED;
  const scr = shellPage('Shared · Members · Admin' + (state ? ' · ' + state : ''), 'Admin', 'Roles & permissions', [
    pageTitle('Roles & permissions', view ? VIEW_ONLY : null, [primaryHeaderButton('Invite admin', view ? 'Disabled' : 'Default')]),
    tabsBar([['Admins', expired ? '6' : '5', true], ['Roles', null, false]]),
    membersTable('Admin', state === 'Loading' || state === 'Load error' ? state : null, expired ? [ADMIN_EXPIRED] : null),
  ]);
  // The menus are placed by estimate under the actions button of the third row (a peer the actor may manage) or the first row (view only); nudge in Figma.
  // A member who outranks the actor or is the last holder of a system role (Omar Saleh) gets every item disabled (ux.md F11 steps 4-5).
  if (state === 'Menu open') add(scr, rowMenu([['Default', 'Change role', 'user'], ['Default', 'Reset two-step verification', 'smartphone'], ['Destructive', 'Deactivate account…', 'ban']], [1128, 438]));
  if (view) add(scr, rowMenu([['Disabled', 'Change role', 'user', VIEW_ONLY], ['Disabled', 'Reset two-step verification', 'smartphone', VIEW_ONLY], ['Disabled', 'Deactivate account…', 'ban', VIEW_ONLY]], [1128, 310]));
  // 1.10.1: the expired invitation (sixth row) with its two actions; "Cancel invitation…" opens the Cancel invitation dialog of Dialogs · Confirm · Admin.
  if (expired) add(scr, invitationMenu([1128, 630]));
  return scr;
}
function tplMembersSeller(state) {
  const scr = shellPage('Shared · Members · Seller' + (state ? ' · ' + state : ''), 'Seller', 'Team & roles', [
    pageTitle('Team & roles', null, [primaryHeaderButton('Invite team member')]),
    tabsBar([['Team', '2', true], ['Roles', null, false]]),
    panelBanner('Team members can sign in now.', 'The parts of the panel they can use appear as MondaPac adds features.'),
    membersTable('Seller', state),
  ]);
  return scr;
}
function memberCard(m, seller) {
  const badges = [statusBadge(m.status)]; if (seller && m.two) badges.push(bdg('Neutral', 'None', 'Two-step ' + m.two.toLowerCase()));
  return frame({ name: m.name, dir: 'V', gap: 'space/3', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
    frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, personCell(m).concat([rowAction(true)])),
    frame({ name: 'role', dir: 'H', gap: 'space/2', align: 'center' }, [text('Role', 'Caption/Default', 'text/muted')].concat(roleNodes(m))),
    frame({ name: 'badges', dir: 'H', gap: 'space/2', align: 'center' }, badges),
  ]);
}
// 1.8.1: the 360 x 780 admin screen (clipped Main, no bottom bar) has room for three member cards; the other two are on the desktop table.
const ADMIN_PHONE_CARDS = 3;
function tplMembersPhone(ws) {
  const seller = ws === 'Seller';
  const kids = [text(seller ? 'Team & roles' : 'Roles & permissions', 'Heading/H1', 'text/primary', { sizeH: 'FILL' })];
  if (seller) kids.push(panelBanner('Team members can sign in now.', 'The parts of the panel they can use appear as MondaPac adds features.'));
  kids.push(fullButton(seller ? 'Invite team member' : 'Invite admin'));
  (seller ? SELLER_MEMBERS : ADMIN_MEMBERS.slice(0, ADMIN_PHONE_CARDS)).forEach(function (m) { kids.push(memberCard(m, seller)); });
  const scr = phoneScreen('Shared · Members · ' + ws + ' (phone)', ws, kids, seller ? 'More' : null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Roles (T8, B2)
const ROLE_GROUPS = {
  Admin: [['System', [{ name: 'Platform owner', system: true, type: 'System', perms: 'All', members: '1' }]],
    ['Default', [{ name: 'Seller reviewer', purpose: 'Reviews seller applications and certificates.', type: 'Default', perms: '14', members: '2' }, { name: 'Support agent', purpose: 'Answers sellers and customers.', type: 'Default', perms: '8', members: '3' }]],
    ['Custom', [{ name: 'Compliance lead', type: 'Custom', perms: '12', members: '1' }, { name: 'Finance reviewer', type: 'Custom', perms: '9', members: '1' }, { name: 'Content editor', type: 'Custom', perms: 'None yet', members: '0' }]]],
  Seller: [['Owner', [{ name: 'Owner', system: true, type: 'Owner', perms: 'All', members: '1' }]],
    ['Ready-made', [{ name: 'Order packer', purpose: 'Packs and prepares orders.', type: 'Ready-made', perms: '4', members: '1' }, { name: 'Catalogue editor', purpose: 'Keeps offers and stock up to date.', type: 'Ready-made', perms: '3', members: '0' }]],
    ['Custom', [{ name: 'Shift lead', type: 'Custom', perms: '6', members: '0' }]]],
};
function roleRow(r) {
  const nameNodes = (r.system ? [icon('lock', 'icon/muted', 14)] : []).concat([frame({ name: 'role', dir: 'V', sizeH: 'FILL' }, [text(r.name, 'Body/Strong'), r.purpose ? text(r.purpose, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true }) : null])]);
  return row([[nameNodes, 'fill'], [typeBadge(r.type), 160], [text(r.perms, 'Body/Default'), 140], [text(r.members, 'Body/Default'), 120], [rowAction(), 56, { justify: 'center' }]], false, false, r.purpose ? 64 : 56);
}
function rolesTable(ws, noCustom) {
  const kids = [headerRow([['Role', 'fill'], ['Type', 160], ['Permissions', 140], ['Members', 120], ['', 56]])];
  ROLE_GROUPS[ws].forEach(function (g) {
    kids.push(groupRow(g[0]));
    if (g[0] === 'Custom' && noCustom) {
      const es = inst('EmptyState', { Size: 'Compact', Icon: { icon: 'users' }, Title: 'No custom roles yet', Body: (ws === 'Admin' ? 'Default' : 'Ready-made') + ' roles cover common jobs. Create a role when you need a different mix of permissions.' }, { name: 'empty-state', sizeH: 'FILL' });
      setNested(es, 'action', prop('Button', 'Label', 'Create role'));
      kids.push(es);
    } else g[1].forEach(function (r) { kids.push(roleRow(r)); });
  });
  return card('Role list', kids);
}
function tplRoles(ws, noCustom) {
  const admin = ws === 'Admin';
  return shellPage('Shared · Roles · ' + ws + (noCustom ? ' · No custom roles' : ''), ws, admin ? 'Roles & permissions' : 'Team & roles', [
    pageTitle(admin ? 'Roles & permissions' : 'Team & roles', null, [primaryHeaderButton('Create role')]),
    tabsBar(admin ? [['Admins', '5', false], ['Roles', null, true]] : [['Team', '2', false], ['Roles', null, true]]),
    rolesTable(ws, noCustom),
  ]);
}
function tplRolesPhone(ws) {
  const kids = [text(ws === 'Admin' ? 'Roles & permissions' : 'Team & roles', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), fullButton('Create role')];
  ROLE_GROUPS[ws].forEach(function (g) {
    kids.push(text(g[0], 'Caption/Overline', 'text/muted'));
    g[1].forEach(function (r) {
      kids.push(frame({ name: r.name, dir: 'V', gap: 'space/2', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
        frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', justify: 'between', sizeH: 'FILL' }, [text(r.name, 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), typeBadge(r.type), rowAction(true)]),
        r.purpose ? text(r.purpose, 'Caption/Default', 'text/muted', { sizeH: 'FILL' }) : null,
        text((r.perms === 'All' ? 'All permissions' : (r.perms === 'None yet' ? 'No permissions yet' : r.perms + ' permissions')) + ' · ' + r.members + ' members', 'Body/Small', 'text/secondary'),
      ]));
    });
  });
  const scr = phoneScreen('Shared · Roles · ' + ws + ' (phone)', ws, kids, ws === 'Seller' ? 'More' : null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- No access and Not found (T9, B5): the shell stays, an EmptyState Page fills the content area
const NO_ACCESS = { icon: 'lock', title: 'You don’t have access to this page', action: 'Go to Home',
  Seller: 'Your role doesn’t include it. Ask your shop owner if you need it.', Admin: 'Your role doesn’t include it. Ask an admin who manages roles.' };
const NOT_FOUND = { icon: 'search', title: 'We can’t find that page', body: 'It may have been removed, or the link may be wrong.', action: 'Go to Home' };
function emptyPage(o) {
  const es = inst('EmptyState', { Size: 'Page', Icon: { icon: o.icon }, Title: o.title, Body: o.body }, { name: 'empty-state', sizeH: o.fill ? 'FILL' : null });
  setNested(es, 'action', prop('Button', 'Label', o.action));
  return es;
}
function tplNoAccess(ws) {
  return shellPage('Shared · No access · ' + ws, ws, ws === 'Seller' ? 'Team & roles' : 'Roles & permissions', [
    frame({ name: 'Content', dir: 'V', align: 'center', justify: 'center', sizeH: 'FILL', sizeV: 'FILL' }, [emptyPage({ icon: NO_ACCESS.icon, title: NO_ACCESS.title, body: NO_ACCESS[ws], action: NO_ACCESS.action })]),
  ], { fixedH: 900 });
}
function tplNotFound() {
  // The crumb and the text name no resource: the answer is the same for a missing record and another seller's record.
  return shellPage('Shared · Not found', 'Seller', 'Not found', [
    frame({ name: 'Content', dir: 'V', align: 'center', justify: 'center', sizeH: 'FILL', sizeV: 'FILL' }, [emptyPage(NOT_FOUND)]),
  ], { fixedH: 900 });
}
function tplEmptyPhone(name, ws, o) {
  const scr = phoneScreen(name, ws, [frame({ name: 'Content', dir: 'V', align: 'center', justify: 'center', sizeH: 'FILL', sizeV: 'FILL' }, [emptyPage(Object.assign({ fill: true }, o))])], ws === 'Seller' ? 'More' : null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Account security (B4)
function securityPassword(o) {
  const kids = [
    authField('Current password', { type: 'Password', filled: true, error: o.errors ? 'Your current password is incorrect.' : null }),
    authField('New password', { type: 'Password', filled: true, helper: o.errors ? null : AUTH_POLICY, error: o.errors ? 'Use 15 to 128 characters.' : null }),
  ];
  if (o.code) kids.push(authField('6-digit code', { type: 'Code', filled: true }));
  kids.push(inst('Button', { Variant: 'Primary', Size: o.touch ? 'Touch' : 'Md', State: 'Default', Label: 'Change password' }, { name: 'primary-action', sizeH: o.touch ? 'FILL' : null }));
  return card('Password', [header('Password', null), frame({ name: 'form', dir: 'V', gap: 'space/4', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)], { sizeH: 'FILL' });
}
function securityTwoStep(kind, touch) {
  const on = kind === 'admin' || kind === 'on';
  const size = touch ? 'Touch' : 'Md';
  const b = function (label, variant) { return inst('Button', { Variant: variant || 'Secondary', Size: size, State: 'Default', Label: label }, { name: 'action', sizeH: touch ? 'FILL' : null }); };
  const kids = [frame({ name: 'status', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [on ? bdg('Success', 'Icon', 'On since 3 Oct 2026', 'check') : bdg('Neutral', 'Icon', 'Off', 'x'), on ? text('8 backup codes left', 'Body/Default', 'text/secondary') : null])];
  if (kind === 'admin') kids.push(text('Admin accounts must keep two-step verification on.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }));
  if (kind === 'off' || kind === 'link') kids.push(text('Shop owners will need two-step verification before payouts are switched on.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }));
  if (kind === 'link') {
    kids.push(text('We’ve sent a link to ' + AUTH.Seller.email + '. Open it within 60 minutes to set up two-step verification.', 'Body/Small', 'text/secondary', { name: 'link-sent', sizeH: 'FILL' }));
    kids.push(inst('Button', { Variant: 'Link', Size: size, State: 'Default', Label: 'Send it again' }, { name: 'resend' }));
  }
  const actions = kind === 'admin' ? [b('Get new backup codes'), b('Move to a new phone')] : (kind === 'on' ? [b('Get new backup codes'), b('Move to a new phone'), b('Turn off…', 'Destructive')] : [b('Set up')]);
  kids.push(frame({ name: 'actions', dir: touch ? 'V' : 'H', gap: 'space/2', wrap: !touch, rowGap: 'space/2', sizeH: 'FILL' }, actions));
  return card('Two-step verification', [header('Two-step verification', null), frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)]);
}
function tplSecurity(ws, kind, errors, saved) {
  const admin = ws === 'Admin';
  const suffix = saved ? ' · Saved' : (admin ? '' : ' · ' + { off: 'Off', link: 'Link sent', on: 'On' }[kind]);
  const scr = shellPage('Shared · Account security · ' + ws + suffix + (errors ? ' · Errors' : ''), ws, 'Account security', [
    pageTitle('Account security', null, []),
    frame({ name: 'Cards', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [securityPassword({ code: kind === 'admin' || kind === 'on', errors: errors }), securityTwoStep(kind)]),
  ], saved ? { fixedH: 900 } : undefined);
  // Toast at the bottom end of the content area, 24 px from the edges (its height is about 76 px).
  if (saved) add(scr, inst('Toast', { Tone: 'Success', Message: 'Password changed. You’ve been signed out on your other devices.' }, { name: 'Toast', abs: [1440 - 400 - 24, 900 - 76 - 24] }));
  return scr;
}
function tplSecurityPhone() {
  const scr = phoneScreen('Shared · Account security · Seller (phone)', 'Seller', [text('Account security', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), securityPassword({ code: false, touch: true }), securityTwoStep('off', true)], 'More');
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Dialogs D1 to D3: template bodies (swap targets of the Dialog Content slot), the dialog instances and the scrim scenes
function tplBody(name, build) {
  if (S.sets[name] && S.sets[name].comp) return S.sets[name].comp;
  const c = figma.createComponent(); c.name = name; c.fills = [];
  body(c, { dir: 'V', w: 360, gap: 'space/4' }, build());
  c.description = 'Template body for the dialog frames: the swap target of the Dialog Content slot. Not library API; the code builds these bodies from Field, Input, Select and Textarea.';
  tag(c); S.sets[name] = { comp: c, keys: {}, axes: [] }; PANEL_BODIES.push(c); S.counts.components++;
  return c;
}
// A Field whose control is a Select (o.select = { state, value }) or an Input (see authField).
function panelField(label, o) {
  o = o || {};
  if (!o.select) return authField(label, o);
  const props = { Label: label, 'Show helper': !!o.helper, 'Show error': false, Control: { comp: S.sets.Select.set.children.filter(function (c) { return c.name === 'State=Default'; })[0] } };
  if (o.helper) props.Helper = o.helper;
  const f = inst('Field', props, { name: 'field-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), sizeH: 'FILL' });
  setNested(f, 'control', Object.assign({ State: o.select.state }, prop('Select', 'Value', o.select.value)));
  return f;
}
function readOnlyPair(label, value) { return frame({ name: label, dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(label, 'Caption/Default', 'text/muted'), text(value, 'Body/Default', 'text/primary', { sizeH: 'FILL' })]); }
function roleList() {
  const m = inst('Menu', { 'Show header': false, 'Show divider': false }, { name: 'role-list', sizeH: 'FILL' });
  setNested(m, 'item-1', menuItemProps('Selected', 'Seller reviewer', null, 'Reviews seller applications and certificates.', false));
  setNested(m, 'item-2', menuItemProps('Default', 'Support agent', null, 'Answers sellers and customers.', false));
  setNested(m, 'item-3', menuItemProps('Disabled', 'Platform owner', null, NOT_HELD, false));
  return m;
}
function bodyInvite(ws, open) {
  const admin = ws === 'Admin';
  const helper = 'They’ll get an email with a link to set their own password. The link works for ' + (admin ? '72 hours' : '7 days') + '.';
  const email = panelField('Email', { value: admin ? 'noor.hassan@mondapac.example' : 'tariq.nasser@kurabyfresh.example' });
  if (!open) return [email, panelField('Role', { select: { state: 'Default', value: 'Select a role' }, helper: helper })];
  return [email, frame({ name: 'role-open', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [panelField('Role', { select: { state: 'Open', value: 'Seller reviewer' } }), roleList(), text(helper, 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])];
}
function bodyChangeRole(ws) {
  const admin = ws === 'Admin';
  return [frame({ name: 'current', dir: 'V', gap: 'space/3', sizeH: 'FILL' }, [readOnlyPair('Name', admin ? 'Amira Said' : 'Amina Rahman'), readOnlyPair('Current role', admin ? 'Finance reviewer' : 'Order packer')]),
    panelField('Role', { select: { state: 'Filled', value: admin ? 'Support agent' : 'Catalogue editor' } }),
    text(DIALOGBODY_TEXT, 'Body/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' })];
}
// o: { name, title, primary, secondary, size, tone, layout, content, text, focusCancel, hideSecondary }
function dlg(o) {
  const p = { Size: o.size || 'Sm', Tone: o.tone || 'Default', Layout: o.layout || 'Centred', Title: o.title, 'Show secondary': !o.hideSecondary };
  if (o.content) p.Content = { comp: o.content };
  const d = inst('Dialog', p, { name: o.name });
  setNested(d, 'primary', prop('Button', 'Label', o.primary));
  if (o.secondary) setNested(d, 'secondary', prop('Button', 'Label', o.secondary));
  if (o.focusCancel) setNested(d, 'secondary', { State: 'Focus' }); // Destructive opens with focus on Cancel
  if (o.text) setNested(d, 'content', prop('DialogBody', 'Body', o.text));
  return d;
}
function dialogScene(name, dialogs) {
  const scr = frame({ name: name, w: 1440, h: 900, fill: 'bg/page', clip: true });
  add(scr, frame({ name: 'scrim', w: 1440, h: 900, fill: 'bg/scrim' }));
  const rowF = frame({ name: 'dialogs', dir: 'H', wrap: true, gap: 'space/6', rowGap: 'space/6', align: 'start', justify: 'center', w: 1280 }, dialogs);
  scr.appendChild(rowF); rowF.x = 80; rowF.y = 80;
  tag(scr);
  return scr;
}
function sheetScene(name, d) {
  const scr = frame({ name: name, w: 360, h: 780, fill: 'bg/page', clip: true });
  add(scr, frame({ name: 'scrim', w: 360, h: 780, fill: 'bg/scrim' }));
  scr.appendChild(d); d.x = 0; d.y = 780 - d.height;
  applyDensity(scr, 'touch');
  tag(scr);
  return scr;
}
function tplDialogsMembers() {
  const b1 = tplBody('Template body · D1 Invite (Admin)', function () { return bodyInvite('Admin', false); });
  const b1o = tplBody('Template body · D1 Invite (Admin, list open)', function () { return bodyInvite('Admin', true); });
  const b2 = tplBody('Template body · D2 Change role (Admin)', function () { return bodyChangeRole('Admin'); });
  return dialogScene('Dialogs · Members · Admin', [
    dlg({ name: 'D1 Invite an admin', title: 'Invite an admin', primary: 'Send invitation', secondary: 'Cancel', content: b1 }),
    dlg({ name: 'D1 Invite an admin · list open', title: 'Invite an admin', primary: 'Send invitation', secondary: 'Cancel', content: b1o }),
    dlg({ name: 'D2 Change role', title: 'Change role for Amira Said', primary: 'Change role', secondary: 'Cancel', content: b2 }),
  ]);
}
function tplDialogsConfirm() {
  return dialogScene('Dialogs · Confirm · Admin', [
    dlg({ name: 'Approve', title: 'Approve this seller?', text: 'They get full access to the seller panel and an email to say so.', primary: 'Approve seller', secondary: 'Cancel' }),
    dlg({ name: 'Deactivate admin', tone: 'Destructive', title: 'Deactivate Amira Said’s admin account?', text: 'They’re signed out straight away and can’t sign in.', primary: 'Deactivate account', secondary: 'Cancel', focusCancel: true }),
    dlg({ name: 'Delete role', tone: 'Destructive', title: 'Delete the role “Finance reviewer”?', text: 'This can’t be undone. 2 pending invitations with this role stop working.', primary: 'Delete role', secondary: 'Cancel', focusCancel: true }),
    dlg({ name: 'Cancel invitation', tone: 'Destructive', title: 'Cancel the invitation to noor.hassan@mondapac.example?', text: 'The link in their email stops working.', primary: 'Cancel invitation', secondary: 'Keep invitation', focusCancel: true }),
    dlg({ name: 'Reset two-step verification', tone: 'Destructive', title: 'Reset two-step verification for Amira Said?', text: 'They’re signed out. At their next sign-in we email them a link to set it up again.', primary: 'Reset', secondary: 'Cancel', focusCancel: true }),
  ]);
}
function tplDialogsTeam() {
  const b1 = tplBody('Template body · D1 Invite (Seller)', function () { return bodyInvite('Seller', false); });
  const b2 = tplBody('Template body · D2 Change role (Seller)', function () { return bodyChangeRole('Seller'); });
  return dialogScene('Dialogs · Team · Seller', [
    dlg({ name: 'D1 Invite a team member', title: 'Invite a team member', primary: 'Send invitation', secondary: 'Cancel', content: b1 }),
    dlg({ name: 'D2 Change role', title: 'Change role for Amina Rahman', primary: 'Change role', secondary: 'Cancel', content: b2 }),
    dlg({ name: 'D3 Remove from team', tone: 'Destructive', title: 'Remove Amina Rahman from your team?', text: 'They’re signed out straight away and can’t sign in to your seller panel again.', primary: 'Remove from team', secondary: 'Cancel', focusCancel: true }),
  ]);
}
function tplSheetChangeRole() {
  const b2 = tplBody('Template body · D2 Change role (Admin)', function () { return bodyChangeRole('Admin'); });
  return sheetScene('Dialog sheet · Change role (phone)', dlg({ name: 'D2 Change role (sheet)', layout: 'Sheet', title: 'Change role for Amira Said', primary: 'Change role', secondary: 'Cancel', content: b2 }));
}
function tplSheetRemove() {
  return sheetScene('Dialog sheet · Remove from team (phone)', dlg({ name: 'D3 Remove from team (sheet)', layout: 'Sheet', tone: 'Destructive', title: 'Remove Amina Rahman from your team?', text: 'They’re signed out straight away and can’t sign in to your seller panel again.', primary: 'Remove from team', secondary: 'Cancel', focusCancel: true }));
}

// ---- the list of 1.8.0 frames: [group, name, make]. "Update library" builds only the names a file does not have yet.
const PANEL_ROWS = ['members', 'roles', 'access', 'security', 'dialogs', 'phone'];
function panelDefs() {
  return {
    'tpl-admin': [
      ['members', 'Shared · Members · Admin', function () { return tplMembersAdmin(null); }],
      ['members', 'Shared · Members · Admin · Menu open', function () { return tplMembersAdmin('Menu open'); }],
      ['members', 'Shared · Members · Admin · Loading', function () { return tplMembersAdmin('Loading'); }],
      ['members', 'Shared · Members · Admin · Load error', function () { return tplMembersAdmin('Load error'); }],
      ['members', 'Shared · Members · Admin · View only', function () { return tplMembersAdmin('View only'); }],
      ['members', 'Shared · Members · Admin · ' + INVITATION_EXPIRED, function () { return tplMembersAdmin(INVITATION_EXPIRED); }], // 1.10.1
      ['roles', 'Shared · Roles · Admin', function () { return tplRoles('Admin', false); }],
      ['roles', 'Shared · Roles · Admin · No custom roles', function () { return tplRoles('Admin', true); }],
      ['access', 'Shared · No access · Admin', function () { return tplNoAccess('Admin'); }],
      ['security', 'Shared · Account security · Admin', function () { return tplSecurity('Admin', 'admin', false); }],
      ['security', 'Shared · Account security · Admin · Errors', function () { return tplSecurity('Admin', 'admin', true); }],
      ['dialogs', 'Dialogs · Members · Admin', tplDialogsMembers],
      ['dialogs', 'Dialogs · Confirm · Admin', tplDialogsConfirm],
      ['phone', 'Shared · Members · Admin (phone)', function () { return tplMembersPhone('Admin'); }],
      ['phone', 'Shared · Not found · Admin (phone)', function () { return tplEmptyPhone('Shared · Not found · Admin (phone)', 'Admin', NOT_FOUND); }],
      ['phone', 'Dialog sheet · Change role (phone)', tplSheetChangeRole],
    ],
    'tpl-seller': [
      ['members', 'Shared · Members · Seller', function () { return tplMembersSeller(null); }],
      ['members', 'Shared · Members · Seller · Empty', function () { return tplMembersSeller('Empty'); }],
      ['members', 'Shared · Members · Seller · Loading', function () { return tplMembersSeller('Loading'); }],
      ['members', 'Shared · Members · Seller · Load error', function () { return tplMembersSeller('Load error'); }],
      ['roles', 'Shared · Roles · Seller', function () { return tplRoles('Seller', false); }],
      ['roles', 'Shared · Roles · Seller · No custom roles', function () { return tplRoles('Seller', true); }],
      ['access', 'Shared · No access · Seller', function () { return tplNoAccess('Seller'); }],
      ['access', 'Shared · Not found', tplNotFound],
      ['security', 'Shared · Account security · Seller · Off', function () { return tplSecurity('Seller', 'off', false); }],
      ['security', 'Shared · Account security · Seller · Link sent', function () { return tplSecurity('Seller', 'link', false); }],
      ['security', 'Shared · Account security · Seller · On', function () { return tplSecurity('Seller', 'on', false); }],
      ['security', 'Shared · Account security · Seller · Saved', function () { return tplSecurity('Seller', 'off', false, true); }],
      ['dialogs', 'Dialogs · Team · Seller', tplDialogsTeam],
      ['phone', 'Shared · Members · Seller (phone)', function () { return tplMembersPhone('Seller'); }],
      ['phone', 'Shared · Roles · Seller (phone)', function () { return tplRolesPhone('Seller'); }],
      ['phone', 'Shared · No access · Seller (phone)', function () { return tplEmptyPhone('Shared · No access · Seller (phone)', 'Seller', { icon: NO_ACCESS.icon, title: NO_ACCESS.title, body: NO_ACCESS.Seller, action: NO_ACCESS.action }); }],
      ['phone', 'Shared · Account security · Seller (phone)', tplSecurityPhone],
      ['phone', 'Dialog sheet · Remove from team (phone)', tplSheetRemove],
    ],
  };
}
// The desktop pages built by shellPage (they hug their content, 1.8.1 minimum height): every group except the dialog scenes and the phone frames.
function panelShellNames(key) { return panelDefs()[key].filter(function (d) { return ['members', 'roles', 'access', 'security'].indexOf(d[0]) >= 0; }).map(function (d) { return d[1]; }); }
function panelNames(key) { return panelDefs()[key].map(function (d) { return d[1]; }); }
// Build the frames in `names` (all when omitted), one canvas row per group below what the host already holds, then the template bodies
// that were made on the way. Returns how many of each were made.
// 1.8.3 passes its own list (panel183Defs, PANEL183_ROWS); its rows go below the 1.8.0 ones.
function addPanelTemplates(host, key, names, defsOf, groups) {
  const defs = (defsOf || panelDefs)()[key].filter(function (d) { return !names || names.indexOf(d[1]) >= 0; });
  const rows = (groups || PANEL_ROWS).map(function (g) { return defs.filter(function (d) { return d[0] === g; }).map(function (d) { return d[2](); }); });
  const y = placeRows(host, rows, bottomEdge(host) + 240);
  const bodies = PANEL_BODIES.length;
  let x = 0; PANEL_BODIES.forEach(function (c) { host.appendChild(c); c.x = x; c.y = y; x += c.width + 80; });
  PANEL_BODIES.length = 0;
  return { frames: defs.length, bodies: bodies };
}
// The sets 1.8.0 templates place (a template is built only when each one is the plugin's own).
const PANEL_TEMPLATE_NEEDS = ['Sidebar', 'Topbar', 'PhoneTopbar', 'BottomTabBar', 'Button', 'Input', 'Field', 'Select', 'Menu', 'MenuItem', 'Badge', 'InfoBanner', 'IdentityTile', 'IconButton', 'Tab', 'CardHeader', 'TableCell', 'Checkbox', 'EmptyState', 'Dialog', 'DialogBody', 'Toast'];

// ==== 45_templates_panel_183.js ====
// ---------------------------------------------------------------- release 1.8.3 templates: Sellers list (P1), role editor (B3), dialogs D4 to D6 and the unsaved-changes dialog
// Spec: figma-1.2.0-spec.md section 3.6 (planned there as 1.2.1) and identity ux.md sections 3.2 to 3.3 and 5 (en-AU copy). Names, emails,
// role names and dates are examples. The permission rows are the rows of the catalogue table in identity DD 5.3 (14 in the admin panel,
// 4 in the seller panel); their labels and descriptions are samples until identity writes permission.<key>.label and .description.
// The D6 name label is "Owner's name" (Hadi, 2026-10-08). The unsaved-changes copy was approved by the owner on 2026-10-08.
// The unsaved-changes dialog has a scene of its own (Dialogs · Role editor · Admin), so Update library adds a frame and never edits
// the 1.8.0 confirm scene. Every frame here is new; Update library builds only the names a file does not have yet.

// ---- Sellers list (P1, Admin; a Phase 2 frame beside Admin · Sellers, which is not touched)
const P1_NAME = 'Admin · Sellers (Phase 2)';
const SELLER_STATUS = { 'Awaiting approval': ['Info', 'clock'], 'Changes needed': ['Attention', 'alert-circle'], Approved: ['Success', 'check'], Suspended: ['Critical', 'ban'], Invited: ['Neutral', 'send'] };
function sellerStatusBadge(s) { const d = SELLER_STATUS[s]; return bdg(d[0], 'Icon', s, d[1]); }
const SELLERS_VIEW_ONLY = 'Your role can view sellers but not change them.';
const RESET_WAITING = 'Two-step reset waiting for the owner (link expires 9 Oct 2026, 3:40 pm)';
// The Seller column is the owner's name over the email (ux.md P1), never the business name.
const P1_AWAITING = [
  { i: 'HY', tone: 'Teal', name: 'Hana Yusuf', email: 'hana@sunnybankspice.example', status: 'Awaiting approval', since: '29 Sep 2026' },
  { i: 'BA', tone: 'Blue', name: 'Bilal Ahmed', email: 'bilal@darraasianmart.example', status: 'Awaiting approval', since: '2 Oct 2026' },
  { i: 'MK', tone: 'Amber', name: 'Mariam Khalil', email: 'mariam@hollandparkbakehouse.example', status: 'Awaiting approval', since: '5 Oct 2026' },
];
const P1_ALL = [P1_AWAITING[0],
  { i: 'IM', tone: 'Purple', name: 'Ibrahim Musa', email: 'ibrahim@logangrocer.example', status: 'Changes needed', since: '3 Oct 2026' },
  { i: 'FN', tone: 'Amber', name: 'Faisal Noor', email: 'faisal@noorpantry.example', status: 'Approved', since: '4 Feb 2026' },
  { i: 'YK', tone: 'Teal', name: 'Yusuf Karimi', email: 'yusuf@kurabyfresh.example', status: 'Approved', since: '12 Mar 2026', reset: true },
  { i: 'KR', tone: 'Neutral', name: 'Khalid Rahimi', email: 'khalid@slackscreekbutchers.example', status: 'Suspended', since: '20 Jan 2026' },
  { i: 'ZA', tone: 'Blue', name: 'Zainab Ali', email: 'zainab@gabbagrocers.example', status: 'Invited', since: '6 Oct 2026' },
];
// Tab counts: [Awaiting approval, Approved, Changes needed, Suspended, Invited, All]; the empty frame has nobody waiting.
const P1_TABS = ['Awaiting approval', 'Approved', 'Changes needed', 'Suspended', 'Invited', 'All'];
function p1Tabs(sel, empty) { const n = empty ? ['0', '6', '1', '1', '1', '9'] : ['3', '6', '1', '1', '1', '12']; return tabsBar(P1_TABS.map(function (t, i) { return [t, n[i], t === sel]; })); }
function p1Count(empty) { return (empty ? '9' : '12') + ' sellers in the Australia market'; }
function sellerCell(m) {
  const kids = personCell(m);
  if (m.reset) add(kids[1], text(RESET_WAITING, 'Caption/Default', 'text/muted', { name: 'reset-waiting', sizeH: 'FILL' }));
  return kids;
}
function sellersTable(list, state) {
  if (state === 'Load error') return listLoadError();
  const kids = [headerRow([['Seller', 'fill'], ['Status', 200], ['Since', 160], ['', 56]])];
  if (state === 'Loading') return card('Seller list', kids.concat(loadingRows([['Two-line', 'fill'], ['Text', 200], ['Text', 160], ['Actions', 56]])));
  if (state === 'Empty') return card('Seller list', kids.concat([inst('EmptyState', { Size: 'Card', Icon: { icon: 'check' }, Title: 'No sellers are waiting', Body: 'You’re up to date.', 'Show action': false }, { name: 'empty-state', sizeH: 'FILL' })]));
  list.forEach(function (m) { kids.push(row([[sellerCell(m), 'fill'], [sellerStatusBadge(m.status), 200], [text(m.since, 'Body/Default'), 160], [rowAction(), 56, { justify: 'center' }]], false, false, m.reset ? 80 : 64)); });
  return card('Seller list', kids);
}
function sellerSearch(touch) {
  return frame({ name: 'search', dir: 'V', gap: 'space/1', w: touch ? undefined : 360, sizeH: touch ? 'FILL' : null }, [
    inst('Input', { Type: 'Text', State: 'Default', Value: 'Search sellers' }, { name: 'search-input', sizeH: 'FILL' }),
    text('Enter the full email address.', 'Caption/Default', 'text/muted', { name: 'search-help', sizeH: 'FILL', truncate: true }), // one short line at 328 px and wider
  ]);
}
// A row menu with 2 or 3 items ([state, label, icon, description]); with 2 the middle item is hidden (Menu "Show item 2").
function actionMenu(items) {
  const two = items.length === 2;
  const m = inst('Menu', { 'Show header': false, 'Show divider': false, 'Show item 2': !two }, { name: 'Row menu (open)' });
  (two ? ['item-1', 'item-3'] : ['item-1', 'item-2', 'item-3']).forEach(function (n, i) { setNested(m, n, menuItemProps(items[i][0], items[i][1], items[i][2], items[i][3])); });
  return m;
}
// Where `node` sits inside `root`, worked out from the auto-layout sizes and alignment (padding, gaps, MIN, CENTER, MAX, SPACE_BETWEEN).
// Only the vertical offset is used: it depends on heights alone, which every hugging frame knows as soon as its children are in place.
function offsetIn(root, node) {
  let x = 0, y = 0;
  for (let n = node; n && n !== root && n.parent; n = n.parent) {
    const p = n.parent;
    if (!p.layoutMode || p.layoutMode === 'NONE' || n.layoutPositioning === 'ABSOLUTE') { x += n.x; y += n.y; continue; }
    const h = p.layoutMode === 'HORIZONTAL';
    const kids = p.children.filter(function (c) { return c.visible && c.layoutPositioning !== 'ABSOLUTE'; });
    const size = function (c) { return h ? c.width : c.height; };
    const total = kids.reduce(function (a, c) { return a + size(c); }, 0);
    const padA = h ? p.paddingLeft : p.paddingTop, avail = (h ? p.width : p.height) - padA - (h ? p.paddingRight : p.paddingBottom);
    let gap = p.itemSpacing, along = padA;
    if (p.primaryAxisAlignItems === 'SPACE_BETWEEN') gap = kids.length > 1 ? (avail - total) / (kids.length - 1) : 0;
    else if (p.primaryAxisAlignItems === 'CENTER') along += (avail - total - gap * (kids.length - 1)) / 2;
    else if (p.primaryAxisAlignItems === 'MAX') along += avail - total - gap * (kids.length - 1);
    for (let k = 0; k < kids.indexOf(n); k++) along += size(kids[k]) + gap;
    const padC = h ? p.paddingTop : p.paddingLeft, cAvail = (h ? p.height : p.width) - padC - (h ? p.paddingBottom : p.paddingRight), cSize = h ? n.height : n.width;
    let across = padC;
    if (p.counterAxisAlignItems === 'CENTER') across += (cAvail - cSize) / 2; else if (p.counterAxisAlignItems === 'MAX') across += cAvail - cSize;
    if (h) { x += along; y += across; } else { x += across; y += along; }
  }
  return [x, y];
}
// Opens `menu` under the actions button of seller row `index` (0-based), 4 px below it, its right edge on the button's right edge.
// The actions column is the last one and the list card fills Main, so the button's right edge is fixed by Main's right padding.
function openUnderRow(scr, index, menu) {
  const rows = scr.findAll(function (n) { return n.type === 'FRAME' && n.name === 'Row' && n.parent && n.parent.name === 'Seller list'; });
  const b = rows[index].findOne(function (n) { return n.name === 'row-actions'; });
  const main = scr.children[1].children[1];
  const right = scr.width - main.paddingRight - (b.parent.width - b.width) / 2;
  setMeta(menu, { abs: [Math.round(Math.max(0, right - menu.width)), Math.round(offsetIn(scr, b)[1] + b.height + 4)] });
  add(scr, menu);
}
function tplSellersP1(state) {
  const all = state === 'Menu open' || state === 'View only', view = state === 'View only', empty = state === 'Empty';
  const kids = [pageTitle('Sellers', p1Count(empty), [primaryHeaderButton('Add seller', view ? 'Disabled' : 'Default')])];
  if (view) kids.push(text(SELLERS_VIEW_ONLY, 'Body/Small', 'text/muted', { name: 'view-only-help', sizeH: 'FILL' }));
  kids.push(sellerSearch(false), p1Tabs(all ? 'All' : 'Awaiting approval', empty), sellersTable(all ? P1_ALL : P1_AWAITING, ['Loading', 'Empty', 'Load error'].indexOf(state) >= 0 ? state : null));
  const scr = screen(P1_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H });
  // The menu holds only the actions the API allows for the row (ux.md P1): Approve and Reject… while awaiting approval; an approved seller can be suspended
  // or have the owner's two-step verification reset. View reason, Lift suspension, Resend and Cancel invitation belong to the other rows. The approved
  // row's menu opens on a seller with no reset waiting: on the row that has one, starting again cancels the earlier link (DD 3.7), which this menu does not say.
  if (state === 'Menu open') {
    openUnderRow(scr, 0, actionMenu([['Default', 'Approve', 'check'], ['Destructive', 'Reject…', 'x']]));
    openUnderRow(scr, 2, actionMenu([['Default', 'Reset owner’s two-step verification…', 'smartphone'], ['Destructive', 'Suspend…', 'ban']]));
  }
  if (view) openUnderRow(scr, 0, actionMenu([['Disabled', 'Approve', 'check', SELLERS_VIEW_ONLY], ['Disabled', 'Reject…', 'x', SELLERS_VIEW_ONLY]]));
  return scr;
}
function sellerCard(m) {
  return frame({ name: m.name, dir: 'V', gap: 'space/3', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
    frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, personCell(m).concat([rowAction(true)])),
    frame({ name: 'status', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [sellerStatusBadge(m.status), text('Since ' + m.since, 'Caption/Default', 'text/muted')]),
  ]);
}
// 360 x 780: the six tabs do not fit a phone, so the status is a Select in a Field; the three awaiting sellers are cards.
function tplSellersP1Phone() {
  const kids = [text('Sellers', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), fullButton('Add seller'), sellerSearch(true), panelField('Status', { select: { state: 'Filled', value: 'Awaiting approval (3)' } })];
  P1_AWAITING.forEach(function (m) { kids.push(sellerCard(m)); });
  const scr = phoneScreen(P1_NAME + ' (phone)', 'Admin', kids, null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Dialogs D4 to D6 (Admin) and the phone sheet
const REASON_HELP = 'The shop owner sees this in an email and when they sign in. Say what was wrong and what to change. Don’t add internal notes.';
const REASON_COUNTER = '0 / 1000'; // the maximum length comes from the API (ux.md D4); 1000 is a sample
// A Field whose control is the Textarea, with the counter on.
function reasonField(error) {
  const ta = S.sets.Textarea.set.children.filter(function (c) { return c.name === 'State=Default'; })[0];
  const props = { Label: 'Reason for the seller', Helper: REASON_HELP, 'Show helper': true, 'Show counter': true, Counter: REASON_COUNTER, 'Show error': !!error, Control: { comp: ta } };
  if (error) props.Error = 'Write a reason before you continue.';
  const f = inst('Field', props, { name: 'field-reason-for-the-seller', sizeH: 'FILL' });
  setNested(f, 'control', { State: error ? 'Error' : 'Default' });
  return f;
}
function bodyReject(error) { return [reasonField(error)]; }
function bodySuspend() { return [text('Everyone on the seller’s team is signed out and can’t sign in until you lift the suspension.', 'Body/Default', 'text/secondary', { name: 'consequence', sizeH: 'FILL' }), reasonField(false)]; }
// Read-only D4 ("View reason"): the text, its author and date (ux.md D4). ReasonQuote keeps no author; the admin view adds one line for it.
function bodyViewReason() { return [inst('ReasonQuote', { Label: 'Reason from MondaPac', Date: 'Written on 3 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }), readOnlyPair('Written by', 'Layla Haddad')]; }
const D6_NAME_HELP = 'The shop owner’s own name, not the business name. They add the store and business names when they set up.';
function bodyAddSeller() {
  return [authField('Owner’s name', { value: 'Rashid Omar', helper: D6_NAME_HELP }), authField('Email', { value: 'rashid@moorookagrocer.example', helper: 'We’ll email them a link to choose their own password. You never see or set it.' }),
    text('The account still needs approval after they accept.', 'Body/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' })];
}
// A scene as tall as its dialogs need (at least 900), so no dialog is cut off.
function tallScene(name, dialogs) {
  const scr = dialogScene(name, dialogs);
  const rowF = scr.children[1], h = Math.max(900, Math.ceil(rowF.y + rowF.height + 80));
  if (h > 900) { scr.resize(1440, h); scr.children[0].resize(1440, h); }
  return scr;
}
function tplDialogsSellers() {
  const b4 = tplBody('Template body · D4 Reject', function () { return bodyReject(false); });
  const b4e = tplBody('Template body · D4 Reject (error)', function () { return bodyReject(true); });
  const b4r = tplBody('Template body · D4 View reason', bodyViewReason);
  const b5 = tplBody('Template body · D5 Suspend', bodySuspend);
  const b6 = tplBody('Template body · D6 Add seller', bodyAddSeller);
  return tallScene('Dialogs · Sellers · Admin', [
    dlg({ name: 'D4 Reject', size: 'Md', tone: 'Destructive', title: 'Reject this seller application?', primary: 'Reject application', secondary: 'Cancel', content: b4, focusCancel: true }),
    dlg({ name: 'D4 Reject · Error', size: 'Md', tone: 'Destructive', title: 'Reject this seller application?', primary: 'Reject application', secondary: 'Cancel', content: b4e }),
    dlg({ name: 'D5 Suspend', size: 'Md', tone: 'Destructive', title: 'Suspend this seller?', primary: 'Suspend seller', secondary: 'Cancel', content: b5, focusCancel: true }),
    // The title has no key in ux.md section 5 yet (sample).
    dlg({ name: 'D4 View reason', size: 'Md', title: 'Reason for Ibrahim Musa', primary: 'Close', hideSecondary: true, content: b4r }),
    dlg({ name: 'D6 Add seller', title: 'Add a seller', primary: 'Send invitation', secondary: 'Cancel', content: b6 }),
  ]);
}
function tplSheetReject() {
  const b4e = tplBody('Template body · D4 Reject (error)', function () { return bodyReject(true); });
  return sheetScene('Dialog sheet · Reject (phone)', dlg({ name: 'D4 Reject (sheet)', layout: 'Sheet', tone: 'Destructive', title: 'Reject this seller application?', primary: 'Reject application', secondary: 'Cancel', content: b4e }));
}
// Leaving the role editor with unsaved changes (approved copy; it opens with focus on "Keep editing").
function tplDialogsRoleEditor() {
  return dialogScene('Dialogs · Role editor · Admin', [
    dlg({ name: 'Unsaved changes', tone: 'Destructive', title: 'Leave without saving?', text: 'You have unsaved changes. They’ll be lost if you leave.', primary: 'Leave', secondary: 'Keep editing', focusCancel: true }),
  ]);
}

// ---- Role editor (B3, both panels)
// [group, label, description, protected (R11)]: one row per row of the catalogue table in identity DD 5.3.
const ADMIN_PERMS = [
  ['Seller access', 'View sellers', 'See sellers awaiting a decision, their status and the reason.'],
  ['Seller access', 'Approve and reject sellers', 'Decide on seller applications.'],
  ['Seller access', 'Suspend sellers', 'Suspend a seller and lift the suspension.'],
  ['Seller accounts', 'Add sellers', 'Invite a new seller; resend or cancel the invitation.'],
  ['Seller accounts', 'Reset a shop owner’s two-step verification', 'Start a reset that the shop owner confirms by email.'],
  ['Customer accounts', 'View customer accounts', 'Find a customer account by email and see its status.'],
  ['Customer accounts', 'Deactivate customer accounts', 'Deactivate and reactivate a customer account.'],
  ['Admin accounts', 'View admins', 'See admin accounts, their roles and open invitations.'],
  ['Admin accounts', 'Invite admins', 'Invite an admin; resend or cancel the invitation.', true],
  ['Admin accounts', 'Deactivate admins', 'Deactivate and reactivate an admin account.', true],
  ['Admin accounts', 'Reset an admin’s two-step verification', 'Reset another admin’s two-step verification.', true],
  ['Roles', 'View roles', 'See roles and their permissions.'],
  ['Roles', 'Create, edit and delete roles', 'Use this role editor.', true],
  ['Roles', 'Change an admin’s role', 'Give an admin a different role.', true],
];
const SELLER_PERMS = [
  ['Team', 'View the team', 'See team members, their roles and open invitations.'],
  ['Team', 'Manage the team', 'Invite and remove team members, change their roles and reset their two-step verification.', true],
  ['Roles', 'View roles', 'See roles and their permissions.'],
  ['Roles', 'Create, edit and delete roles', 'Use this role editor.', true],
];
const R10_HELP = 'New features are never added to a custom role automatically. You choose when to add them.';
const PROTECTED_ADMIN = 'Only a Platform owner can give this permission.'; // role.help.protected with {systemRoleName}; the role name is a sample
const PROTECTED_SELLER = 'Only the shop owner can do this. It can’t be given to team members yet.';
const ACTOR_NOT_HELD = [3, 6]; // the signed-in admin (Layla Haddad, Compliance lead) does not hold Add sellers and Deactivate customer accounts (R1)
// A ticked permission the actor does not hold stays ticked and locked: they can neither give it nor take it away (sample copy, no ux.md key yet).
const NOT_HELD_CHANGE = 'You can’t change a permission you don’t have.';
// Row states of one editor: o.checked (indexes), o.readOnly; editable rows are disabled when protected or not held, with the reason.
// Only a duplicate drops what the actor does not hold (o.dropNotHeld, with the banner); editing an existing role keeps its stored value.
function permRows(perms, ws, o) {
  return perms.map(function (p, i) {
    const r = { group: p[0], label: p[1], desc: p[2], badge: !!p[3], value: o.checked.indexOf(i) >= 0 ? 'Checked' : 'Unchecked', state: o.readOnly ? 'Read-only' : 'Default' };
    if (o.readOnly) return r;
    if (p[3]) { r.state = 'Disabled'; r.desc = ws === 'Admin' ? PROTECTED_ADMIN : PROTECTED_SELLER; }
    else if (ws === 'Admin' && ACTOR_NOT_HELD.indexOf(i) >= 0) {
      r.state = 'Disabled';
      if (o.dropNotHeld) r.value = 'Unchecked';
      r.desc = r.value === 'Checked' ? NOT_HELD_CHANGE : NOT_HELD;
    }
    return r;
  });
}
// "Select all in {group}" ticks and clears only the rows the actor can give, so its state comes from those rows alone; with none it is disabled.
function permCard(group, rows, readOnly) {
  const free = rows.filter(function (r) { return r.state === 'Default'; }), counted = free.length ? free : rows;
  const on = counted.filter(function (r) { return r.value === 'Checked'; }).length;
  const all = on === 0 ? 'Unchecked' : (on === counted.length ? 'Checked' : 'Indeterminate');
  const head = frame({ name: 'card-header', dir: 'H', gap: 'space/3', align: 'center', justify: 'between', px: 'space/4', py: 'space/3', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [
    text(group, 'Heading/H2', 'text/primary', { name: 'resource' }),
    readOnly ? null : frame({ name: 'select-all', dir: 'H', gap: 'space/2', align: 'center' }, [inst('Checkbox', { Value: all, State: free.length ? 'Default' : 'Disabled' }, { name: 'select-all-checkbox' }), text('Select all in ' + group, 'Body/Default', free.length ? 'text/primary' : 'text/muted', { name: 'select-all-label' })]),
  ]);
  return card('Permissions · ' + group, [head].concat(rows.map(function (r) {
    return inst('CheckboxRow', { Value: r.value, State: r.state, Label: r.label, Description: r.desc, 'Show badge': r.badge }, { name: 'permission · ' + r.label, sizeH: 'FILL' });
  })));
}
function permCards(rows, readOnly) {
  const groups = []; rows.forEach(function (r) { if (groups.indexOf(r.group) < 0) groups.push(r.group); });
  return groups.map(function (g) { return permCard(g, rows.filter(function (r) { return r.group === g; }), readOnly); });
}
function backLink(touch) { return inst('Button', { Variant: 'Ghost', Size: touch ? 'Touch' : 'Sm', State: 'Default', Label: 'Roles', 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
function actionBar(touch) {
  const b = function (label, variant) { return inst('Button', { Variant: variant, Size: touch ? 'Touch' : 'Md', State: 'Default', Label: label }, { name: variant === 'Primary' ? 'save' : 'cancel', sizeH: touch ? 'FILL' : null }); };
  // On a phone the bar sits above the safe area (the larger bottom padding).
  return frame({ name: 'Action bar', dir: 'H', gap: 'space/2', align: 'center', pad: touch ? ['space/3', 'space/4', 'space/8', 'space/4'] : ['space/3', 'space/8', 'space/3', 'space/8'], fill: 'bg/surface', stroke: 'border/default', sides: ['top'], sizeH: 'FILL' }, [b('Save role', 'Primary'), b('Cancel', 'Secondary')]);
}
// The editor content: o = { ws, title, type, readOnly, checked, banner: [title, body], nameValue, nameError, info: [title, body] }
function editorContent(o) {
  const rows = permRows(o.ws === 'Admin' ? ADMIN_PERMS : SELLER_PERMS, o.ws, o);
  const kids = [];
  if (o.banner) { const bn = panelBanner(o.banner[0], o.banner[1] || ' '); if (!o.banner[1]) bn.findOne(function (n) { return n.name === 'body'; }).visible = false; kids.push(bn); }
  if (!o.readOnly) {
    kids.push(authField('Role name', { value: o.nameValue || '', helper: R10_HELP, error: o.nameError }));
    kids.push(text(rows.filter(function (r) { return r.value === 'Checked'; }).length + ' of ' + rows.length + ' permissions selected', 'Body/Strong', 'text/primary', { name: 'selected-count' }));
  }
  return kids.concat(permCards(rows, o.readOnly));
}
function titleBlock(o) { return pageTitle(o.title, null, o.duplicate ? [btn('Duplicate', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'copy' } })] : [], typeBadge(o.type)); }
function tplRoleEditor(o) {
  const admin = o.ws === 'Admin';
  // At 1440 the cards sit in one column of readable width; the rest of the row stays empty (spec 3.6).
  const column = frame({ name: 'Content column', dir: 'V', gap: 'space/5', w: 760 }, editorContent(o));
  const scr = shellPage('Shared · Role editor · ' + o.ws + ' · ' + o.suffix, o.ws, admin ? 'Roles & permissions' : 'Team & roles', [backLink(false), titleBlock(o), column]);
  // "Save role" and "Cancel" are pinned to the bottom in code; the frame shows the whole list with the bar at its end. Read-only roles have no bar.
  if (!o.readOnly) add(scr.children[1], actionBar(false));
  return scr;
}
function tplRoleEditorPhone() {
  const o = SELLER_EDITORS[0];
  const main = frame({ name: 'Main', dir: 'V', gap: 'space/3', pad: 'space/4', sizeH: 'FILL' }, [backLink(true), titleBlock(o)].concat(editorContent(o)));
  // The whole editor at 360 wide (it is longer than one screen); the bar is pinned in code.
  const scr = frame({ name: 'Shared · Role editor · Seller (phone)', dir: 'V', w: 360, fill: 'bg/page' }, [phoneTopbar('Seller'), main, actionBar(true)]);
  scr.minHeight = 780;
  applyDensity(scr, 'touch');
  tag(scr);
  return scr;
}
const ADMIN_EDITORS = [
  // A custom role being edited (the Roles list still shows it with no permissions: the changes are not saved). It holds Add sellers, which this admin
  // does not hold, so that row is ticked and locked.
  { ws: 'Admin', suffix: 'Custom', title: 'Content editor', type: 'Custom', nameValue: 'Content editor', checked: [0, 3, 5, 11] },
  { ws: 'Admin', suffix: 'Default', title: 'Seller reviewer', type: 'Default', readOnly: true, duplicate: true, checked: [0, 1, 2, 3], banner: ['Default role from MondaPac.', 'It can’t be changed. Duplicate it to make your own version.'] },
  { ws: 'Admin', suffix: 'System', title: 'Platform owner', type: 'System', readOnly: true, checked: ADMIN_PERMS.map(function (p, i) { return i; }), banner: ['System role.', 'It always has every permission in this panel and can’t be changed or deleted.'] },
  { ws: 'Admin', suffix: 'Duplicate', title: 'Copy of Seller reviewer', type: 'Custom', nameValue: 'Copy of Seller reviewer', checked: [0, 1, 2, 3], dropNotHeld: true, banner: ['Some permissions weren’t copied because you can’t give them.'] },
  { ws: 'Admin', suffix: 'Errors', title: 'Content editor', type: 'Custom', nameValue: 'Finance reviewer', nameError: 'A role with this name already exists.', checked: [0, 3, 5, 11] },
];
const SELLER_EARLY = ['Only a few permissions exist so far.', 'More appear here as MondaPac adds features.'];
const SELLER_EDITORS = [
  { ws: 'Seller', suffix: 'Custom', title: 'Weekend staff', type: 'Custom', nameValue: 'Weekend staff', checked: [0, 2], banner: SELLER_EARLY },
  { ws: 'Seller', suffix: 'Ready-made', title: 'Order packer', type: 'Ready-made', readOnly: true, duplicate: true, checked: [0, 2], banner: ['Ready-made role from MondaPac.', 'It can’t be changed. Duplicate it to make your own version.'] },
  { ws: 'Seller', suffix: 'Owner', title: 'Owner', type: 'Owner', readOnly: true, checked: [0, 1, 2, 3], banner: ['Owner role.', 'It always has every permission in this panel and can’t be changed or deleted.'] },
  // A new role: no name yet and nothing ticked; Save stays enabled (a role with no permissions can be saved, DD 5.6).
  { ws: 'Seller', suffix: 'New role · early catalogue', title: 'Create role', type: 'Custom', nameValue: '', checked: [], banner: SELLER_EARLY },
];

// ---- the list of 1.8.3 frames: [group, name, make]
const PANEL183_ROWS = ['sellers', 'role-editor', 'dialogs', 'phone'];
function panel183Defs() {
  const editor = function (o) { return ['role-editor', 'Shared · Role editor · ' + o.ws + ' · ' + o.suffix, function () { return tplRoleEditor(o); }]; };
  return {
    'tpl-admin': [
      ['sellers', P1_NAME, function () { return tplSellersP1(null); }],
      ['sellers', P1_NAME + ' · Menu open', function () { return tplSellersP1('Menu open'); }],
      ['sellers', P1_NAME + ' · View only', function () { return tplSellersP1('View only'); }],
      ['sellers', P1_NAME + ' · Loading', function () { return tplSellersP1('Loading'); }],
      ['sellers', P1_NAME + ' · Empty', function () { return tplSellersP1('Empty'); }],
      ['sellers', P1_NAME + ' · Load error', function () { return tplSellersP1('Load error'); }],
    ].concat(ADMIN_EDITORS.map(editor), [
      ['dialogs', 'Dialogs · Sellers · Admin', tplDialogsSellers],
      ['dialogs', 'Dialogs · Role editor · Admin', tplDialogsRoleEditor],
      ['phone', P1_NAME + ' (phone)', tplSellersP1Phone],
      ['phone', 'Dialog sheet · Reject (phone)', tplSheetReject],
    ]),
    'tpl-seller': SELLER_EDITORS.map(editor).concat([['phone', 'Shared · Role editor · Seller (phone)', tplRoleEditorPhone]]),
  };
}
// The desktop pages of 1.8.3 that hug their content with the 900 px minimum (the role editor phone frame has its own 780 minimum).
function panel183ShellNames(key) { return panel183Defs()[key].filter(function (d) { return d[0] === 'sellers' || d[0] === 'role-editor'; }).map(function (d) { return d[1]; }); }
// The sets the 1.8.3 templates place, on top of the 1.8.0 ones (a template is built only when each one is the plugin's own).
const PANEL183_TEMPLATE_NEEDS = PANEL_TEMPLATE_NEEDS.concat(['Textarea', 'CheckboxRow', 'ReasonQuote']);

// ==== 46_templates_setup.js ====
// ---------------------------------------------------------------- release 1.9.0 templates: Seller setup, S1 to S6 (planned as 1.3.0 in sellers ux.md 8.1 item 1)
// Spec: sellers ux.md 3.0, 3.1, 3.3, 3.5 and section 5 (en-AU copy). The steps sit in the limited seller shell (ID-UX F5, as S1 in 1.7.0); every
// frame is new and named "Seller · Setup · S<n> <screen>[ · <state>]", so the 1.7.0 S1 frames ("Seller · Your seller account · …", identity
// steps only) are not touched and Update library builds only the names a file does not have yet. Rule 4: the address fields and their
// labels, the business-number label and help, the tax question and the storefront address come from the API; the AU Market's values are
// shown because AU is the launch Market. Names, numbers, addresses and dates are examples.

const SETUP = { store: 'Kuraby Fresh', business: 'Kuraby Fresh Pty Ltd', phone: '0412 345 678', contact: 'hello@kurabyfresh.example', signIn: 'yusuf@kurabyfresh.example',
  street: '45 Station Road', locality: 'Kuraby', region: 'Queensland', postcode: '4112', zone: 'Brisbane time', zoneId: 'Australia/Brisbane', localTime: '10:14 AEST',
  idLabel: 'ABN', idHelp: '11 digits', abn: '12 345 678 901', taxQuestion: 'Is your business registered for GST?', taxFrom: '1 Jul 2024',
  storefront: 'mondapac.com.au/shop/', slug: 'kuraby-fresh', slugMin: 3, slugMax: 40, submitted: '6 Oct 2026, 10:14 AEST', withdrawn: '7 Oct 2026' };
// [screen id, title, step number]; S2 to S6 are steps 1 to 5.
const SETUP_STEPS = { business: ['S2', 'Business details', 1], address: ['S3', 'Address and area', 2], number: ['S4', 'Business number', 3], slug: ['S5', 'Shop web address', 4], submit: ['S6', 'Review and submit', 5] };
const SETUP_TOTAL = 5;
const STORE_HELP = 'Customers see this name. Don’t use words that claim a certification, and don’t copy another brand.';
const CONTACT_HELP = 'For customers and MondaPac to reach your business. You still sign in with ' + SETUP.signIn + '.';
const ZONE_HELP = 'We use this to work out your local time for cut-offs and certificate dates. Only MondaPac can change it.';
const OUTSIDE_AREA = ['We’re not in your area yet.', 'We’ve saved your details. You can submit once we open there.']; // error.address.outside-service-area, split into title and body
const EDIT_WARNING = ['Your application is waiting for review.', 'If you change anything, your submission is withdrawn and you’ll need to submit again.']; // edit-warning.banner, split
const SLUG_HELP = 'Lowercase letters, numbers and hyphens. ' + SETUP.slugMin + ' to ' + SETUP.slugMax + ' characters.';
const SLUG_SUGGESTED = 'Suggested from your store name. You can change it.'; // F13 step 5; no key yet (Jafar's wording)
const NUMBER_STATUS = {
  Checking: ['Checking', 'Checking with the official register…'],
  Matched: ['Success', 'Matched with the official register'],
  'Not matched': ['Critical', 'We couldn’t match this number with the official register. Check it and try again, or contact us.'],
  'Could not be checked': ['Info', 'We couldn’t check this right now. You can still submit, and a reviewer will check it.'],
  'Limit reached': ['Critical', 'You’ve changed this number too many times. Try again later.'],
};
const SLUG_STATUS = { Checking: ['Checking', 'Checking…'], Available: ['Success', 'Available now. It’s held for you when you submit.'], 'Not available': ['Critical', 'That address isn’t available. Try another.'], Throttled: ['Info', 'Too many checks. Wait a moment.'] };

function setupName(id, title, state, phone) { return 'Seller · Setup · ' + id + ' ' + title + (state ? ' · ' + state : '') + (phone ? ' (phone)' : ''); }
function stepName(key, state, phone) { const d = SETUP_STEPS[key]; return setupName(d[0], d[1], state, phone); }

// A Field (see authField) with the 1.9.0 parts: o.optional, o.status = [tone, text], o.prefix (the Input's fixed prefix).
function setupField(label, o) {
  o = o || {};
  const f = authField(label, o);
  const own = {};
  if (o.optional) Object.assign(own, prop('Field', 'Optional', true));
  if (o.status) Object.assign(own, prop('Field', 'Show status', true));
  if (Object.keys(own).length) f.setProperties(own);
  if (o.status) setNested(f, 'status', Object.assign({ Tone: o.status[0] }, prop('FieldStatus', 'Text', o.status[1])));
  if (o.prefix) setNested(f, 'control', Object.assign(prop('Input', 'Show prefix', true), prop('Input', 'Prefix', o.prefix)));
  return f;
}
function setupCard(title, kids) { return card(title, [header(title, null), frame({ name: 'body', dir: 'V', gap: 'space/4', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)]); }
function setupNote(s, name) { return text(s, 'Body/Small', 'text/muted', { name: name || 'note', sizeH: 'FILL' }); }
function setupBanner(tone, title, bodyText, action) {
  const p = { Tone: tone, Title: title, Body: bodyText, 'Show action': !!action }; if (action) p.Action = action;
  return inst('InfoBanner', p, { name: tone === 'Critical' ? 'error-summary' : 'banner', sizeH: 'FILL' });
}
function backToAccount(touch) { return inst('Button', { Variant: 'Ghost', Size: touch ? 'Touch' : 'Sm', State: 'Default', Label: 'Back to your seller account', 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
function stepHeader(key, touch) {
  const d = SETUP_STEPS[key];
  return frame({ name: 'Page header', dir: 'V', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [backToAccount(touch), text(d[1], 'Heading/H1', 'text/primary', { name: 'title', sizeH: 'FILL' }), text('Step ' + d[2] + ' of ' + SETUP_TOTAL, 'Body/Small Strong', 'text/muted', { name: 'step-counter' })]);
}
// The save bar: o.state (Clean, Dirty, Saving, Error), o.primary / o.secondary labels (secondary null hides it), o.disabled, o.noStatus.
function setupBar(o, sticky) {
  o = o || {};
  const bar = inst('FormActionBar', { Layout: sticky ? 'Sticky' : 'Inline', State: o.state || 'Clean' }, { name: 'FormActionBar', sizeH: 'FILL' });
  const own = {};
  if (o.secondary === null) Object.assign(own, prop('FormActionBar', 'Show secondary', false));
  if (o.noStatus) Object.assign(own, prop('FormActionBar', 'Show status', false));
  if (Object.keys(own).length) bar.setProperties(own);
  const pr = prop('Button', 'Label', o.primary || 'Save and continue'); if (o.disabled) pr.State = 'Disabled';
  setNested(bar, 'primary', pr);
  if (o.secondary) setNested(bar, 'secondary', prop('Button', 'Label', o.secondary));
  return bar;
}
// Desktop step page: limited shell, form column at most size/form-max (3.0 rules 1 and 2). touch: the step pages S2 to S6 have 48 px
// targets at every width (ux.md 6, Touch density as on Auth), so their Main takes the Touch dimension mode; the shell stays Desktop.
function setupPage(name, kids, w, touch) {
  const main = frame({ name: 'Main', dir: 'V', pad: ['space/7', 'space/8', 'space/10', 'space/8'], sizeH: 'FILL' }, [frame({ name: 'content', dir: 'V', gap: 'space/5', w: w || 'size/form-max' }, kids)]);
  if (touch) applyDensity(main, 'touch');
  const col = frame({ name: 'Column', dir: 'V', sizeH: 'FILL' }, [
    inst('Topbar', { Workspace: 'Seller', Crumb: 'Your seller account', 'Show search': false, 'Show notifications': false }, { name: 'Topbar', sizeH: 'FILL' }),
    main,
  ]);
  const scr = frame({ name: name, dir: 'H', w: 1440, fill: 'bg/page', clip: true }, [limitedSidebar(), col]);
  scr.minHeight = PANEL_MIN_H;
  tag(scr);
  return scr;
}
// Phone step page (360 wide, touch density): the content scrolls in Main, the save bar is pinned below it (Sticky).
function setupPhone(name, kids, bar) {
  const scr = phoneScreen(name, 'Seller', kids, null);
  const topbar = scr.children[0];
  ['menu-button', 'notifications'].forEach(function (n) { const x = topbar.findOne(function (k) { return k.name === n; }); if (x) x.visible = false; });
  if (bar) add(scr, bar);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- S1 Your seller account, with the sellers steps (ux.md 3.1 S1 and 3.3)
// Step states: [state, by, detail]; detail is the steps.detail line (null: none).
const S1_SETUP = {
  'Details needed': { badge: ['Neutral', 'clipboard'], banner: ['Info', 'Finish your details', 'Complete the steps below, then submit them for review.'],
    steps: [['Done', 'Done'], ['To do', 'To do', '4 fields left'], ['To do', 'To do', '2 fields left'], ['To do', 'To do', '1 field left']], submit: ['Waiting', 'Waiting'], review: ['To do', 'To do'] },
  'Ready to submit': { badge: ['Info', 'send'], banner: ['Info', 'Your details are ready', 'Submit them for review when you’re ready.', 'Review and submit'],
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['To do', 'To do'], review: ['To do', 'To do'] },
  'Not in your area yet': { badge: ['Attention', 'map-pin'], banner: ['Attention', 'We’re not in your area yet', 'Your details are saved. You can submit once we open there.', 'Contact us'],
    steps: [['Done', 'Done'], ['Needs attention', 'Not in your area yet'], ['Done', 'Done'], ['Done', 'Done']], submit: ['Waiting', 'Waiting'], review: ['To do', 'To do'] },
  'Awaiting review': { badge: ['Info', 'clock'], banner: ['Info', 'We’re reviewing your application', 'We’ll email you when there’s a decision. Until then you can’t sell. Changing your details withdraws your submission.'],
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['Done', 'Done'], review: ['Waiting', 'In progress'], submitted: 'Submitted on ' + SETUP.submitted, withdraw: true },
  'Changes needed': { badge: ['Attention', 'alert-circle'], banner: ['Attention', 'Your application needs changes', 'Read the reason, update your details and submit again.'],
    reason: 'We couldn’t accept the business name you gave. Use the legal name of your business, then submit again.',
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['To do', 'To do'], review: ['Needs attention', 'Needs changes'] }, // a reason carries no step data, so every step stays Done
  'Not approved': { badge: ['Critical', 'x'], banner: ['Critical', 'Your application wasn’t approved', 'You’ve reached the limit for new applications. Contact us if you have questions.', 'Contact us'],
    reason: 'The business details you gave don’t meet our requirements for new shops.',
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['Done', 'Done'], review: ['Needs attention', 'Not approved'] },
};
// Two frames reuse a state with another line (ux.md 3.1 S1): after MondaPac withdrew the submission, and when MondaPac submitted for the seller.
const S1_SETUP_FRAMES = [['Details needed'], ['Ready to submit'], ['Ready to submit', 'Withdrawn'], ['Not in your area yet'], ['Awaiting review'], ['Awaiting review', 'Submitted by MondaPac'], ['Changes needed'], ['Not approved']];
function setupStep(s, title, chevron) {
  const p = { State: s[0], Title: title, By: s[1], 'Show actions': false };
  const i = inst('ChecklistItem', p, { name: 'step', sizeH: 'FILL' });
  const own = {};
  if (s[2]) Object.assign(own, prop('ChecklistItem', 'Show detail', true), prop('ChecklistItem', 'Detail', s[2]));
  if (chevron) Object.assign(own, prop('ChecklistItem', 'Show chevron', true));
  if (Object.keys(own).length) i.setProperties(own);
  return i;
}
function s1SetupContent(state, variant) {
  const st = S1_SETUP[state];
  const banner = variant === 'Withdrawn'
    ? setupBanner('Info', 'Your submission was withdrawn on ' + SETUP.withdrawn + ' because MondaPac edited your details.', 'Submit again when you’re ready.', 'Review and submit')
    : setupBanner(st.banner[0], st.banner[1], st.banner[2], st.banner[3]);
  const head = [frame({ name: 'title-row', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [text('Your seller account', 'Heading/H1'), bdg(st.badge[0], 'Icon', state, st.badge[1])])];
  if (variant === 'Submitted by MondaPac') head.push(setupNote('MondaPac submitted these details for you on 6 Oct 2026.', 'submitted'));
  else if (st.submitted) head.push(setupNote(st.submitted, 'submitted'));
  const slot = frame({ name: 'certification-slot', dir: 'H', pad: [12, 18, 12, 18], sizeH: 'FILL', stroke: 'border/row', sides: ['top'] }, [
    frame({ name: 'slot', dir: 'H', px: 'space/3', py: 'space/2', stroke: 'border/input', dash: [4, 4], radius: 'radius/control', sizeH: 'FILL' }, [text('Slot for the certificate steps (not needed to submit)', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
  ]);
  const stepTitles = ['Business details', 'Address and area', 'Business number', 'Shop web address'];
  const steps = [setupStep(['Done', '3 Oct 2026'], 'Account created'), setupStep(['Done', '3 Oct 2026'], 'Email confirmed')]
    .concat(st.steps.map(function (s, i) { return setupStep(s, stepTitles[i], true); }))
    .concat([slot, setupStep(st.submit, 'Review and submit', true), setupStep(st.review, 'MondaPac reviews your application')]);
  const kids = [frame({ name: 'Page header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, head), banner];
  if (st.reason) kids.push(inst('ReasonQuote', { Reason: st.reason, Date: 'Written on 6 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }));
  kids.push(card('Steps', steps));
  if (st.withdraw) kids.push(frame({ name: 'withdraw', dir: 'H', sizeH: 'FILL' }, [btn('Withdraw submission', 'Secondary', 'Md')]));
  kids.push(card('Help', [frame({ name: 'help', dir: 'V', gap: 'space/3', pad: [16, 18, 16, 18], sizeH: 'FILL' }, [text('Protect your account', 'Heading/H2'), text('Turn on two-step verification while you wait.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }), btn('Set up two-step verification', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'smartphone' } }), text(AUTH_SUPPORT, 'Body/Small', 'text/muted', { name: 'support', sizeH: 'FILL' })])]));
  return kids;
}
function s1SetupName(state, variant, phone) { return setupName('S1', 'Your seller account', state + (variant ? ' · ' + variant : ''), phone); }
function tplS1Setup(state, variant) { return setupPage(s1SetupName(state, variant), s1SetupContent(state, variant), 760); }
function tplS1SetupPhone(state) { return setupPhone(s1SetupName(state, null, true), s1SetupContent(state), null); }

// ---- S2 Business details
// o.fresh: a new file, nothing saved yet (ux.md 3.5: empty fields, no "Saved").
function s2Content(o) {
  o = o || {};
  const st = o.readOnly ? 'Disabled' : null; const v = function (x) { return o.fresh ? '' : x; };
  const kids = [];
  if (o.errors) kids.push(setupBanner('Critical', 'Check the details below', 'Enter a phone number.'));
  if (o.awaiting) kids.push(setupBanner('Attention', EDIT_WARNING[0], EDIT_WARNING[1]));
  if (o.readOnly) kids.push(setupBanner('Attention', 'MondaPac is recording a decision.', 'Try again in a moment.'));
  kids.push(setupCard('Your shop', [
    setupField('Store name', { value: v(SETUP.store), helper: STORE_HELP, state: st }),
    setupField('Business name', { value: v(SETUP.business), helper: 'The legal name of your business.', state: st }),
    o.errors ? setupField('Phone', { value: '', error: 'Enter a phone number.' }) : setupField('Phone', { value: v(SETUP.phone), state: st }),
    setupField('Contact email', { value: v(SETUP.contact), helper: CONTACT_HELP, optional: true, state: st }),
    readOnlyPair('Sign-in email', SETUP.signIn),
  ]));
  return kids;
}
function s2Bar(o, sticky) { o = o || {}; return setupBar({ state: o.errors ? 'Error' : (o.awaiting ? 'Dirty' : 'Clean'), secondary: 'Back to checklist', disabled: o.readOnly, noStatus: o.fresh }, sticky); } // awaiting review: the button keeps "Save and continue"; D3 carries "Save and withdraw" (ux.md flow F14 step 2)
function tplS2(state, o) { return setupPage(stepName('business', state), [stepHeader('business')].concat(s2Content(o), [s2Bar(o)]), null, true); }
function tplS2Phone() { return setupPhone(stepName('business', null, true), [stepHeader('business', true)].concat(s2Content()), s2Bar({}, true)); }

// ---- S3 Address and area
// The AU Market's address fields in its order (from the API). On a phone the Suburb and Postcode pair stacks (ux.md 6).
function addressFields(registered, fresh) {
  const v = function (x, y) { return fresh ? '' : (registered ? y : x); };
  return [
    setupField('Street address', { value: v(SETUP.street, '2/18 Logan Road') }),
    frame({ name: 'locality-row', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [setupField('Suburb', { value: v(SETUP.locality, 'Woolloongabba') }), setupField('Postcode', { value: v(SETUP.postcode, '4102') })]),
    panelField('State', { select: fresh ? { state: 'Default', value: 'Select a state' } : { state: 'Filled', value: SETUP.region } }),
  ];
}
function zoneResult() {
  return frame({ name: 'zone-result', dir: 'H', gap: 'space/2-5', align: 'start', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [
    icon('clock', 'icon/muted', 18),
    frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Your work time zone is ' + SETUP.zone + ' (' + SETUP.zoneId + ').', 'Body/Strong', 'text/primary', { name: 'zone', sizeH: 'FILL' }), setupNote('Local time now: ' + SETUP.localTime, 'local-time'), setupNote(ZONE_HELP, 'zone-help')]),
  ]);
}
function s3Content(o) {
  o = o || {};
  const kids = [];
  if (o.outside) kids.push(setupBanner('Attention', OUTSIDE_AREA[0], OUTSIDE_AREA[1]));
  if (o.unresolved) kids.push(setupBanner('Attention', 'We couldn’t work out your time zone from this address.', 'Check the address, or contact us.', 'Contact us')); // error.timezone.unresolved, split
  const check = inst('CheckboxRow', { Value: o.registered ? 'Checked' : 'Unchecked', State: 'Default', Label: 'My registered business address is different', Description: 'Only the address where your shop works from sets your service area and time zone.' }, { name: 'registered-different', sizeH: 'FILL' });
  const body = addressFields(false, o.fresh).concat([check]);
  if (!o.fresh && !o.outside && !o.unresolved && !o.registered) body.push(zoneResult());
  kids.push(setupCard('Where your shop works from', body));
  if (o.registered) kids.push(setupCard('Registered business address', addressFields(true)));
  return kids;
}
function tplS3(state, o) { o = o || {}; return setupPage(stepName('address', state), [stepHeader('address')].concat(s3Content(o), [setupBar({ state: o.registered ? 'Dirty' : 'Clean', secondary: 'Back to checklist', noStatus: o.fresh })]), null, true); }

// ---- S4 Business number and tax registration
function numberField(state) {
  if (state === 'Empty') return setupField(SETUP.idLabel, { value: '', helper: SETUP.idHelp });
  if (state === 'Format error') return setupField(SETUP.idLabel, { value: '12 345 678', helper: SETUP.idHelp, error: 'That doesn’t look like a valid ' + SETUP.idLabel + '. Check the number and try again.' });
  const s = NUMBER_STATUS[state];
  return setupField(SETUP.idLabel, { value: SETUP.abn, helper: SETUP.idHelp, status: s ? [s[0], s[1]] : null });
}
// The tax answer is required and never preselected: before an answer no segment is selected (an override of segment 1 in this
// instance; the SegmentedControl component always draws its first segment selected). "Registered from" follows a Yes.
function segNone(seg) {
  const s1 = seg.findOne(function (n) { return n.name === 'segment-1'; }); if (s1) s1.fills = [];
  const l1 = seg.findOne(function (n) { return n.name === 'label-1'; });
  if (l1) { S.pending.push(l1.setTextStyleIdAsync(S.ts['Body/Default'].id)); l1.fills = [paint('text/secondary')]; }
}
function taxCard(answered) {
  const seg = inst('SegmentedControl', { 'Segment 1': 'Yes', 'Segment 2': 'No' }, { name: 'tax-answer' });
  const third = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (third) third.visible = false;
  if (!answered) segNone(seg);
  const kids = [frame({ name: 'question', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text(SETUP.taxQuestion, 'Body/Strong', 'text/primary', { name: 'tax-question', sizeH: 'FILL' }), seg, setupNote('MondaPac doesn’t decide whether you must register.', 'tax-help')])];
  if (answered) kids.push(setupField('Registered from', { value: SETUP.taxFrom }));
  return setupCard('Tax registration', kids);
}
function s4Content(state) { return [setupCard('Business number', [numberField(state)]), taxCard(state !== 'Empty')]; }
// First visit: nothing saved, no result line, the tax question unanswered. Saved: the number matched and the answer Yes.
function tplS4() { return setupPage(stepName('number'), [stepHeader('number')].concat(s4Content('Empty'), [setupBar({ secondary: 'Back to checklist', noStatus: true })]), null, true); }
function tplS4Saved() { return setupPage(stepName('number', 'Saved'), [stepHeader('number')].concat(s4Content('Matched'), [setupBar({ secondary: 'Back to checklist' })]), null, true); }
// One board with the business-number field in each result state (ux.md 3.1 S4), as the frontend builds them.
const NUMBER_BOARD = ['Checking', 'Matched', 'Not matched', 'Could not be checked', 'Limit reached', 'Format error', 'No register lookup'];
const SLUG_BOARD = ['Idle', 'Checking', 'Available', 'Not available', 'Format error', 'Throttled'];
function stateBoard(name, title, note, states, make) {
  const cells = states.map(function (s) { return frame({ name: s, dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text(s, 'Caption/Strong', 'text/muted', { name: 'state' }), card(s, [frame({ name: 'body', dir: 'V', pad: 'space/5', sizeH: 'FILL' }, [make(s)])])]); });
  const scr = frame({ name: name, dir: 'V', w: 720, pad: 40, gap: 'space/6', fill: 'bg/page' }, [frame({ name: 'board-header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(title, 'Heading/H1'), para(note, 640)])].concat(cells));
  tag(scr);
  return scr;
}
function tplS4States() {
  return stateBoard(stepName('number', 'Result states'), 'Business number: result states', 'The result line under the field after a save (ux.md 3.1 S4). Not matched is one message for "not found" and "cancelled". With no register lookup in the Market there is no result line. A format or checksum error is the field error.', NUMBER_BOARD, numberField);
}

// ---- S5 Shop web address
function slugField(state) {
  if (state === 'Format error') return setupField('Shop web address', { value: 'Kuraby--Fresh', prefix: SETUP.storefront, error: 'Use ' + SETUP.slugMin + ' to ' + SETUP.slugMax + ' lowercase letters, numbers and hyphens, with no hyphen at the start, end or in a row.' });
  const s = SLUG_STATUS[state];
  return setupField('Shop web address', { value: SETUP.slug, prefix: SETUP.storefront, helper: SLUG_HELP, status: s ? [s[0], s[1]] : null });
}
// First visit: the field is prefilled by code from the store name (not AI), editable and marked as a suggestion (F13 step 5); nothing is saved yet.
function s5Content(state) {
  const kids = [slugField(state)];
  if (state === 'Idle') kids.push(setupNote(SLUG_SUGGESTED, 'suggestion'));
  kids.push(setupNote('You can only change this later by asking MondaPac.', 'help-later'));
  return [setupCard('Shop web address', kids)];
}
function tplS5() { return setupPage(stepName('slug'), [stepHeader('slug')].concat(s5Content('Idle'), [setupBar({ secondary: 'Back to checklist', noStatus: true })]), null, true); }
function tplS5States() {
  return stateBoard(stepName('slug', 'Statuses'), 'Shop web address: statuses', 'Checked on blur and after 600 ms without typing, one request at a time; no check for a format error, which is local (ux.md 3.1 S5). Taken and reserved show the same text.', SLUG_BOARD, slugField);
}

// ---- S6 Review and submit
// Rows: [card, label, value, state, note]; state Missing or Blocked marks a row.
function s6Rows(o) {
  o = o || {};
  return [
    ['Business details', 'Store name', SETUP.store], ['Business details', 'Business name', SETUP.business], ['Business details', 'Phone', SETUP.phone, o.missing ? 'Missing' : null], ['Business details', 'Contact email', SETUP.contact],
    ['Address and area', 'Where your shop works from', SETUP.street + ', ' + SETUP.locality + ' ' + SETUP.region + ' ' + SETUP.postcode, o.blocked ? 'Blocked' : null, o.blocked ? 'We’re not in your area yet.' : null], ['Address and area', 'Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'],
    ['Business number', SETUP.idLabel, SETUP.abn, o.blocked ? 'Blocked' : null, o.blocked ? 'We couldn’t match this number with the official register.' : null], ['Business number', SETUP.taxQuestion, 'Yes'], ['Business number', 'Registered from', SETUP.taxFrom],
    ['Shop web address', 'Shop web address', SETUP.storefront + SETUP.slug, o.missing ? 'Missing' : null],
  ];
}
// A blocked row carries its reason in the note and "Contact us" as the second action (F13 step 6); a phone uses Width=Narrow.
function dataRow(r, readOnly, narrow) {
  const p = { Layout: 'Single', Width: narrow ? 'Narrow' : 'Wide', State: r[3] || 'Default', Label: r[1], 'Show action': !readOnly };
  if (r[3] !== 'Missing') p.Value = r[2];
  if (r[4]) { p['Show note'] = true; p.Note = r[4]; }
  if (r[3] === 'Blocked') p['Show second action'] = true;
  return inst('DataRow', p, { name: 'row · ' + r[1], sizeH: 'FILL' });
}
function s6Cards(o) {
  o = o || {};
  const rows = s6Rows(o); const groups = [];
  rows.forEach(function (r) { if (groups.indexOf(r[0]) < 0) groups.push(r[0]); });
  return groups.map(function (g) { return card(g, [header(g, null)].concat(rows.filter(function (r) { return r[0] === g; }).map(function (r) { return dataRow(r, o.awaiting, o.touch); }))); });
}
function s6Content(o) {
  o = o || {};
  const d = SETUP_STEPS.submit;
  const kids = [frame({ name: 'Page header', dir: 'V', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [backToAccount(o.touch), text(d[1], 'Heading/H1', 'text/primary', { name: 'title', sizeH: 'FILL' }), text('Step ' + d[2] + ' of ' + SETUP_TOTAL, 'Body/Small Strong', 'text/muted', { name: 'step-counter' })])];
  if (o.empty) {
    kids.push(inst('EmptyState', { Size: 'Card', Title: 'Nothing saved yet', Body: 'Start with your business details.', Icon: { icon: 'clipboard' } }, { name: 'empty', sizeH: 'FILL' }));
    setNested(kids[kids.length - 1], 'action', prop('Button', 'Label', 'Business details'));
    return kids;
  }
  if (o.awaiting) kids.push(setupBanner('Info', 'We’re reviewing your application', 'Submitted on ' + SETUP.submitted + '. Changing your details withdraws your submission.'));
  else kids.push(setupBanner('Info', 'Before you submit', 'MondaPac reviews these details before you can sell. You’ll get an email when there’s a decision.'));
  return kids.concat(s6Cards(o));
}
function s6Bar(o, sticky) {
  o = o || {};
  if (o.awaiting) return frame({ name: 'withdraw', dir: 'H', sizeH: 'FILL' }, [btn('Withdraw submission', 'Secondary', sticky ? 'Touch' : 'Md')]);
  const bar = setupBar({ primary: o.again ? 'Submit again' : 'Submit for review', secondary: null, noStatus: true, disabled: o.missing || o.blocked }, sticky);
  if (!o.missing && !o.blocked) return bar;
  // "Finish {n} items first" (submit.help.blocked), linking to the first missing or blocked item, beside the disabled button.
  return frame({ name: 'submit', dir: 'V', gap: 'space/2', align: 'end', sizeH: 'FILL' }, [inst('Button', { Variant: 'Link', Size: sticky ? 'Touch' : 'Sm', State: 'Default', Label: 'Finish 2 items first.' }, { name: 'blocked-reason' }), bar]);
}
function tplS6(state, o) { o = o || {}; const kids = s6Content(o); if (!o.empty) kids.push(s6Bar(o)); return setupPage(stepName('submit', state), kids, null, true); }
function tplS6Phone() { return setupPhone(stepName('submit', null, true), s6Content({ touch: true }), s6Bar({}, true)); }

// ---- the list of 1.9.0 frames: [group, name, make], all on Templates · Seller
const SETUP_ROWS = ['setup-account', 'setup-details', 'setup-number', 'setup-submit', 'setup-phone'];
function setupDefs() {
  return { 'tpl-seller': S1_SETUP_FRAMES.map(function (f) { return ['setup-account', s1SetupName(f[0], f[1]), function () { return tplS1Setup(f[0], f[1]); }]; }).concat([
    ['setup-details', stepName('business'), function () { return tplS2(null, { fresh: true }); }],
    ['setup-details', stepName('business', 'Saved'), function () { return tplS2('Saved'); }],
    ['setup-details', stepName('business', 'Errors'), function () { return tplS2('Errors', { errors: true }); }],
    ['setup-details', stepName('business', 'Awaiting review'), function () { return tplS2('Awaiting review', { awaiting: true }); }],
    ['setup-details', stepName('business', 'Decision in progress'), function () { return tplS2('Decision in progress', { readOnly: true }); }],
    ['setup-details', stepName('address'), function () { return tplS3(null, { fresh: true }); }],
    ['setup-details', stepName('address', 'Saved'), function () { return tplS3('Saved'); }],
    ['setup-details', stepName('address', 'Registered address'), function () { return tplS3('Registered address', { registered: true }); }],
    ['setup-details', stepName('address', 'Outside area'), function () { return tplS3('Outside area', { outside: true }); }],
    ['setup-details', stepName('address', 'Time zone unresolved'), function () { return tplS3('Time zone unresolved', { unresolved: true }); }],
    ['setup-number', stepName('number'), tplS4],
    ['setup-number', stepName('number', 'Saved'), tplS4Saved],
    ['setup-number', stepName('number', 'Result states'), tplS4States],
    ['setup-number', stepName('slug'), tplS5],
    ['setup-number', stepName('slug', 'Statuses'), tplS5States],
    ['setup-submit', stepName('submit'), function () { return tplS6(null); }],
    ['setup-submit', stepName('submit', 'Missing'), function () { return tplS6('Missing', { missing: true }); }],
    ['setup-submit', stepName('submit', 'Blocked'), function () { return tplS6('Blocked', { blocked: true }); }],
    ['setup-submit', stepName('submit', 'Submit again'), function () { return tplS6('Submit again', { again: true }); }],
    ['setup-submit', stepName('submit', 'Awaiting review'), function () { return tplS6('Awaiting review', { awaiting: true }); }],
    ['setup-submit', stepName('submit', 'Empty'), function () { return tplS6('Empty', { empty: true }); }],
    ['setup-phone', s1SetupName('Details needed', null, true), function () { return tplS1SetupPhone('Details needed'); }],
    ['setup-phone', stepName('business', null, true), tplS2Phone],
    ['setup-phone', stepName('submit', null, true), tplS6Phone],
  ]) };
}
function setupNames() { return setupDefs()['tpl-seller'].map(function (d) { return d[1]; }); }
// The sets the 1.9.0 templates place (a template is built only when each one is the plugin's own).
const SETUP_TEMPLATE_NEEDS = ['Sidebar', 'Topbar', 'PhoneTopbar', 'Button', 'Input', 'Field', 'FieldStatus', 'Select', 'Badge', 'InfoBanner', 'CardHeader', 'ChecklistItem', 'ReasonQuote', 'CheckboxRow', 'SegmentedControl', 'DataRow', 'FormActionBar', 'EmptyState'];
// Dark preview copy added in 1.9.0.
const DARK_190 = [stepName('number', 'Saved'), stepName('submit', 'Missing'), stepName('submit', 'Blocked')];

// ==== 47_templates_seller_admin.js ====
// ---------------------------------------------------------------- release 1.10.0 templates: Seller admin (planned as 1.4.0 in sellers ux.md 8.1 item 2)
// Spec: sellers ux.md 3.1 S7 and 3.1a, 3.2 P1 to P4 and C1, 3.2a, 3.4 and section 5 (en-AU copy). Admin frames go to Templates · Admin, the
// store profile (S7) to Templates · Seller. Every frame is new; Update library builds only the names a file does not have yet, so the
// Phase 2 sellers list (1.8.3) and the Phase 2 Admin · Sellers frame are not touched. Rule 4 of 3.0: the register name, the business-number
// label, the address fields, the tax question, the checks and the prepared reasons come from the API; the AU Market's values are shown
// because AU is the launch Market. Names, numbers, addresses, dates and check names are examples. A text with no key in ux.md section 5 is a
// sample, listed in docs/design/figma/README.md. Seller states use Badge with an icon (StatusBadge holds order states only).

const SA_STATUS = { 'Awaiting review': ['Info', 'clock'], 'Details needed': ['Neutral', 'clipboard'], 'Ready to submit': ['Info', 'send'], 'Not in your area yet': ['Attention', 'map-pin'], 'Changes needed': ['Attention', 'alert-circle'],
  'Not approved': ['Critical', 'x'], Approved: ['Success', 'check'], 'Seller approved': ['Success', 'check'], Suspended: ['Critical', 'ban'], Invited: ['Neutral', 'send'] };
function saBadge(s) { const d = SA_STATUS[s]; return bdg(d[0], 'Icon', s, d[1]); }
const SA_REVIEWER = 'Layla Haddad';
const SA_RECORDED = 'Recorded by ' + SA_REVIEWER + ' on 8 Oct 2026, 10:02 AEST';
const SA_NOT_RECORDED = 'Not recorded yet.'; // no key yet (sample)
const SA_MARKET = 'Australia';
const SA_SELLERS = {
  sunnybank: { i: 'SS', tone: 'Purple', store: 'Sunnybank Spice Market', slug: 'sunnybank-spice', name: 'Hana Yusuf', email: 'hana@sunnybankspice.example' },
  darra: { i: 'DA', tone: 'Blue', store: 'Darra Asian Mart', slug: 'darra-asian-mart', name: 'Bilal Ahmed', email: 'bilal@darraasianmart.example' },
  kuraby: { i: 'KF', tone: 'Teal', store: SETUP.store, slug: SETUP.slug, name: 'Yusuf Karimi', email: SETUP.signIn },
  logan: { i: 'LF', tone: 'Amber', store: 'Logan Family Grocer', slug: 'logan-family-grocer', name: 'Ibrahim Musa', email: 'ibrahim@loganfamilygrocer.example' },
  holland: { i: 'HP', tone: 'Neutral', store: 'Holland Park Bakehouse', slug: 'holland-park-bakehouse', name: 'Mariam Khalil', email: 'mariam@hollandparkbakehouse.example' },
  toowoomba: { i: 'TS', tone: 'Blue', store: 'Toowoomba Spice House', slug: 'toowoomba-spice', name: 'Omar Farouk', email: 'omar@toowoombaspice.example' },
  goldcoast: { i: 'GP', tone: 'Purple', store: 'Gold Coast Pantry', slug: 'gold-coast-pantry', name: 'Aisha Rahman', email: 'aisha@goldcoastpantry.example' },
  noor: { i: 'NP', tone: 'Amber', store: 'Noor Pantry', slug: 'noor-pantry', name: 'Faisal Noor', email: 'faisal@noorpantry.example' },
  gabba: { i: 'WO', tone: 'Teal', store: 'Woolloongabba Grocers', slug: 'gabba-grocers', name: 'Zainab Ali', email: 'zainab@gabbagrocers.example' },
  moorooka: { i: 'MG', tone: 'Blue', store: 'Moorooka Grocer', slug: 'moorooka-grocer', name: 'Rashid Omar', email: 'rashid@moorookagrocer.example' },
  slacks: { i: 'SC', tone: 'Neutral', store: 'Slacks Creek Butchers', slug: 'slacks-creek-butchers', name: 'Khalid Rahimi', email: 'khalid@slackscreekbutchers.example' },
};
// An InfoBanner with a title only (the body layer is hidden), for the one-sentence messages of section 5. An Info banner here shows the
// info icon (an override in this instance): the InfoBanner's own Info icon is badge-check, the certificate chip's glyph, which would read as
// "verified" next to a register result or the certificate slot.
function saBanner(tone, title, action, name) {
  const p = { Tone: tone, Title: title, Body: ' ', 'Show action': !!action }; if (action) p.Action = action;
  const b = inst('InfoBanner', p, { name: name || 'banner', sizeH: 'FILL' });
  const bodyT = b.findOne(function (n) { return n.name === 'body'; }); if (bodyT) bodyT.visible = false;
  if (tone === 'Info') infoIcon(b);
  return b;
}
function infoIcon(b) {
  const ic = b.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'icon-badge-check'; }); if (!ic) return;
  ic.swapComponent(S.icons.info); ic.name = 'icon-info'; recolor(ic, 'text/link');
}
function saLine(s, name, color) { return text(s, 'Body/Small', color || 'text/muted', { name: name || 'note', sizeH: 'FILL' }); }
function linkBtn(label, ic, name) { const p = { Variant: 'Link', Size: 'Sm', State: 'Default', Label: label }; if (ic) { p['Leading icon'] = true; p.Icon = { icon: ic }; } return inst('Button', p, { name: name || 'link' }); }
function backTo(label) { return inst('Button', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Label: label, 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
// A card with a CardHeader and a padded body.
function saCard(title, kids, o) { o = o || {}; return card(title, [header(title, o.action || null), frame({ name: 'body', dir: 'V', gap: o.gap || 'space/3', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)], o.w ? { sizeH: null, w: o.w } : undefined); }

// A DataRow: o = { label, value, compare, valueLabel, compareLabel, state, narrow, note, flag: [tone, leading, label, icon], action, second }
function saRow(o) {
  const p = { Layout: o.compare !== undefined ? 'Compare' : 'Single', Width: o.narrow ? 'Narrow' : 'Wide', State: o.state || 'Default', Label: o.label, 'Show action': !!o.action, 'Show flag': !!o.flag, 'Show note': !!o.note, 'Show second action': !!o.second };
  if (o.value !== undefined) p.Value = o.value;
  if (o.compare !== undefined) { p['Compare value'] = o.compare; p['Value label'] = o.valueLabel; p['Compare label'] = o.compareLabel; }
  if (o.note) p.Note = o.note;
  const r = inst('DataRow', p, { name: 'row · ' + o.label, sizeH: 'FILL' });
  if (o.flag) setNested(r, 'flag', Object.assign({ Tone: o.flag[0], Leading: o.flag[1] }, prop('Badge', 'Label', o.flag[2]), o.flag[3] ? prop('Badge', 'Icon', S.icons[o.flag[3]].id) : {}));
  if (o.action) setNested(r, 'action', prop('Button', 'Label', o.action));
  if (o.second) setNested(r, 'second-action', prop('Button', 'Label', o.second));
  return r;
}
const FLAG = { matches: ['Success', 'Icon', 'Matches', 'check'], differs: ['Attention', 'Icon', 'Differs', 'alert-circle'], notCompared: ['Neutral', 'None', 'Not compared'], waiting: ['Info', 'Icon', 'Waiting for review', 'clock'], notAccepted: ['Critical', 'Icon', 'Not accepted', 'x'] };
// A reviewer check (CheckboxRow, 1.10.0): c = { label, desc, value, state, required, undo }; "Required" is the row's badge.
function reviewCheck(c) {
  const r = inst('CheckboxRow', { Value: c.value || 'Unchecked', State: c.state || 'Default', Label: c.label, Description: c.desc || SA_NOT_RECORDED, 'Show badge': !!c.required, 'Show undo': !!c.undo }, { name: 'check · ' + c.label, sizeH: 'FILL' });
  if (c.required) setNested(r, 'badge', Object.assign({ Tone: 'Neutral', Leading: 'None' }, prop('Badge', 'Label', 'Required')));
  return r;
}
// A SettingRow (1.10.0): o = { label, desc, state, meta, msg, seg: [segment 1, segment 2], off }
function settingRow(o) {
  const p = { State: o.state || 'Default', Label: o.label, 'Show meta': !!o.meta };
  if (o.desc) p.Description = o.desc;
  if (o.meta) p.Meta = o.meta;
  if (o.msg || SETTINGROW_MSG[p.State]) p.Message = o.msg || SETTINGROW_MSG[p.State][2];
  if (o.seg) p.Control = { comp: S.sets.SegmentedControl.comp };
  const r = inst('SettingRow', p, { name: 'setting · ' + o.label, sizeH: 'FILL' });
  if (!o.desc) { const d = r.findOne(function (n) { return n.name === 'description'; }); if (d) d.visible = false; }
  if (o.seg) {
    setNested(r, 'control', Object.assign(prop('SegmentedControl', 'Segment 1', o.seg[0]), prop('SegmentedControl', 'Segment 2', o.seg[1])));
    const third = r.findOne(function (n) { return n.name === 'segment-3'; }); if (third) third.visible = false;
  } else if (o.off) setNested(r, 'control', { On: 'False' });
  return r;
}
function confirmDlg(name, title, body, primary, o) { o = o || {}; return dlg({ name: name, title: title, text: body, primary: primary, secondary: o.secondary || 'Cancel', tone: o.tone, size: o.size, focusCancel: o.tone === 'Destructive' }); }

// ---- P1 Sellers (Phase 3 frame; ux.md 3.2 P1, F16, F17)
const P1P3_NAME = 'Admin · Sellers (Phase 3)';
const P1P3_TABS = ['Awaiting review', 'Incomplete', 'Changes needed', 'Not approved', 'Approved', 'Suspended', 'Invited', 'All'];
const P1P3_COUNTS = ['5', '2', '1', '1', '3', '1', '1', '13'];
// Awaiting review, oldest first: [seller, kind, since, status, flags]; Since is the date of the current submission. flags: locked (a change
// request, not selectable), busy (a decision is being recorded). All counts each seller once: Kuraby's change request is an approved seller's row.
const P1P3_AWAITING = [['darra', 'New application', '2 Oct 2026'], ['logan', 'New application', '5 Oct 2026'], ['sunnybank', 'New application', '6 Oct 2026'],
  ['kuraby', 'Change request', '7 Oct 2026', 'Approved', { locked: true }], ['holland', 'New application', '7 Oct 2026', null, { busy: true }]];
const P1P3_SELECTED = [0, 1, 2];
const P1P3_INCOMPLETE = [['toowoomba', null, '4 Oct 2026', 'Not in your area yet'], ['goldcoast', null, '6 Oct 2026', 'Not in your area yet']];
const P1P3_APPROVED = [['kuraby', null, '12 Mar 2026', 'Approved'], ['noor', null, '4 Feb 2026', 'Approved'], ['gabba', null, '7 Jul 2026', 'Approved']];
const P1P3_ALL = [['sunnybank', null, '6 Oct 2026', 'Awaiting review'], ['toowoomba', null, '4 Oct 2026', 'Not in your area yet'], ['moorooka', null, '5 Oct 2026', 'Not approved'],
  ['kuraby', null, '12 Mar 2026', 'Approved'], ['slacks', null, '20 Jan 2026', 'Suspended'], ['gabba', null, '6 Oct 2026', 'Invited']];
const SEARCH_HELP = 'Store name, shop web address, or the full ' + SETUP.idLabel + '.';
const SEARCH_DISABLED = 'Search works on All, Awaiting review and Incomplete.';
const BULK_CAP = 'You can select up to 50 sellers at a time.';
const CHANGE_LOCKED = 'Change requests are decided one at a time.';
function p1p3Search(disabled, touch) {
  return frame({ name: 'search', dir: 'V', gap: 'space/1', w: touch ? undefined : 360, sizeH: touch ? 'FILL' : null }, [
    inst('Input', { Type: 'Text', State: disabled ? 'Disabled' : 'Default', Value: 'Search sellers' }, { name: 'search-input', sizeH: 'FILL' }),
    text(disabled ? SEARCH_DISABLED : SEARCH_HELP, 'Caption/Default', 'text/muted', { name: 'search-help', sizeH: 'FILL' }),
  ]);
}
function p1p3SellerCell(m, extra) {
  const lines = [text(m.store, 'Body/Strong', 'text/primary', { name: 'store', sizeH: 'FILL', truncate: true }), text(m.slug, 'Caption/Default', 'text/muted', { name: 'slug', sizeH: 'FILL', truncate: true }),
    text(m.name + ' · ' + m.email, 'Caption/Default', 'text/muted', { name: 'owner', sizeH: 'FILL', truncate: true })];
  if (extra) lines.push(text(extra, 'Caption/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' }));
  return [inst('IdentityTile', { Tone: m.tone, Shape: 'Rounded', Initials: m.i }), frame({ name: 'seller', dir: 'V', sizeH: 'FILL' }, lines)];
}
function addChip(label, name) {
  const c = inst('FilterChip', { Type: 'Add' }, { name: name });
  const t = c.findOne(function (n) { return n.name === 'add-label'; }); if (t) t.characters = '+ ' + label;
  return c;
}
function selectHeader(value, state) { return frame({ name: 'th select', dir: 'H', w: 56, h: 42, align: 'center', justify: 'center', fill: 'bg/subtle', stroke: 'border/default', sides: ['bottom'] }, [inst('Checkbox', { Value: value, State: state || 'Default' }, { name: 'select-all' })]); }
// o: { tab, rows, selected (indexes), select (checkbox column), viewOnly }
function p1p3Table(o) {
  const awaiting = o.tab === 'Awaiting review';
  const cols = [['Seller', 'fill'], ['Status', 200]].concat(awaiting ? [['Kind', 160]] : [], [['Since', 130], ['', 56]]);
  const head = headerRow(cols);
  if (o.select) {
    const sel = (o.selected || []).length; const free = o.rows.filter(function (r) { return !(r[4] && (r[4].locked || r[4].busy)); }).length;
    head.insertChild(0, selectHeader(sel === 0 ? 'Unchecked' : (sel === free ? 'Checked' : 'Indeterminate'), o.viewOnly ? 'Disabled' : 'Default'));
  }
  const kids = [head];
  o.rows.forEach(function (r, i) {
    const m = SA_SELLERS[r[0]]; const f = r[4] || {}; const on = (o.selected || []).indexOf(i) >= 0;
    const cells = [];
    if (o.select) cells.push([inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: o.viewOnly || f.locked || f.busy ? 'Disabled' : 'Default' }, { name: 'select' }), 56, { justify: 'center' }]);
    cells.push([p1p3SellerCell(m, f.locked ? CHANGE_LOCKED : null), 'fill']);
    cells.push([f.busy ? frame({ name: 'status', dir: 'V', gap: 'space/1' }, [saBadge(r[3] || 'Awaiting review'), text('Decision being recorded', 'Caption/Default', 'text/secondary', { name: 'busy' })]) : saBadge(r[3] || 'Awaiting review'), 200]);
    if (awaiting) cells.push([text(r[1], 'Body/Default'), 160]);
    cells.push([text(r[2], 'Body/Default'), 130], [f.busy ? null : rowAction(), 56, { justify: 'center' }]);
    kids.push(row(cells, on, false, f.locked ? 96 : 80));
  });
  return card('Seller list', kids);
}
function bulkBar(count, cap) {
  const bar = inst('BulkActionBar', {}, { name: 'BulkActionBar' });
  setNested(bar, 'count-badge', prop('CountBadge', 'Count', count));
  setNested(bar, 'action-3', prop('Button', 'Label', 'Reject…'));
  const two = bar.findOne(function (n) { return n.name === 'action-2'; }); if (two) two.visible = false;
  const kids = [bar];
  if (cap) kids.push(frame({ name: 'cap', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon('info', 'status/attention/fg', 16), text(BULK_CAP, 'Body/Small Strong', 'status/attention/fg', { name: 'cap-text' })]));
  return frame({ name: 'bulk-wrap', dir: 'H', gap: 'space/3', align: 'center', justify: 'center', sizeH: 'FILL' }, kids);
}
// state: null (Awaiting review), Selected, Selection limit, Incomplete, Approved, View only
function tplP1P3(state) {
  const tab = { Incomplete: 'Incomplete', Approved: 'Approved', 'View only': 'All' }[state] || 'Awaiting review';
  const view = state === 'View only', limit = state === 'Selection limit';
  const counts = limit ? ['64'].concat(P1P3_COUNTS.slice(1, 7), ['72']) : P1P3_COUNTS;
  const kids = [pageTitle('Sellers', (limit ? '72' : '13') + ' sellers in the ' + SA_MARKET + ' market', [primaryHeaderButton('Add seller', view ? 'Disabled' : 'Default')])];
  if (view) kids.push(text(SELLERS_VIEW_ONLY, 'Body/Small', 'text/muted', { name: 'view-only-help', sizeH: 'FILL' }));
  const chips = [];
  if (tab === 'Awaiting review') chips.push(addChip('Kind', 'kind-filter'));
  if (tab === 'All') chips.push(addChip('Needs a check', 'needs-check-filter'));
  if (tab === 'Incomplete') chips.push(inst('FilterChip', { Type: 'Applied', Label: 'Outside service area' }, { name: 'outside-filter' }));
  kids.push(frame({ name: 'filters', dir: 'H', gap: 'space/3', align: 'start', sizeH: 'FILL' }, [p1p3Search(tab === 'Approved')].concat(chips)));
  kids.push(tabsBar(P1P3_TABS.map(function (t, i) { return [t, counts[i], t === tab]; })));
  const rows = { Incomplete: P1P3_INCOMPLETE, Approved: P1P3_APPROVED, All: P1P3_ALL }[tab] || P1P3_AWAITING;
  const selected = state === 'Selected' ? P1P3_SELECTED : (limit ? P1P3_SELECTED : []);
  kids.push(p1p3Table({ tab: tab, rows: rows, select: tab === 'Awaiting review', selected: selected }));
  if (state === 'Selected' || limit) kids.push(bulkBar(limit ? '50' : '3', limit));
  const scr = screen(P1P3_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H, gap: 'space/5' });
  // View only (All tab): the menu of an approved seller; viewing stays, the identity actions are disabled with the reason (ux.md 3.0 rule 6).
  if (view) openUnderRow(scr, 3, actionMenu([['Default', 'Open', 'eye'], ['Disabled', 'Reset owner’s two-step verification…', 'smartphone', SELLERS_VIEW_ONLY], ['Disabled', 'Suspend…', 'ban', SELLERS_VIEW_ONLY]]));
  return scr;
}
// Empty per tab (ux.md 3.5); a sentence is split into title and body where it has two.
const P1P3_EMPTY = { 'Awaiting review': ['check', 'No sellers are waiting', 'You’re up to date.'], Incomplete: ['clipboard', 'No incomplete applications.'], 'Changes needed, Not approved, Approved, Suspended, Invited': ['users', 'No sellers here.'],
  'Outside service area': ['map-pin', 'No sellers are outside the service area.'], 'Search with no result': ['search', 'No sellers match.', null, 'Clear search'] };
function p1p3Empty(s) {
  const d = P1P3_EMPTY[s];
  const es = inst('EmptyState', { Size: 'Card', Icon: { icon: d[0] }, Title: d[1], Body: d[2] || ' ', 'Show action': !!d[3] }, { name: 'empty-state', sizeH: 'FILL' });
  if (!d[2]) { const b = es.findOne(function (n) { return n.name === 'body'; }); if (b) b.visible = false; }
  if (d[3]) setNested(es, 'action', prop('Button', 'Label', d[3]));
  return es;
}
function tplP1P3Empty() { return stateBoard(P1P3_NAME + ' · Empty states', 'Sellers: empty states', 'The table body when a tab, the outside-area filter or a search has nothing (ux.md 3.5). The tabs, search and header stay. A list that cannot load is the Critical banner with "Try again", not an empty state.', Object.keys(P1P3_EMPTY), p1p3Empty); }
// Below 760 px each row is a card with the same actions menu and no bulk selection (ux.md 6).
function tplP1P3Phone() {
  const kids = [text('Sellers', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), fullButton('Add seller'), p1p3Search(false, true), panelField('Status', { select: { state: 'Filled', value: 'Awaiting review (5)' } })];
  P1P3_AWAITING.slice(0, 3).forEach(function (r) {
    const m = SA_SELLERS[r[0]];
    kids.push(frame({ name: m.store, dir: 'V', gap: 'space/3', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
      frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [inst('IdentityTile', { Tone: m.tone, Shape: 'Rounded', Initials: m.i }), frame({ name: 'seller', dir: 'V', sizeH: 'FILL' }, [text(m.store, 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), text(m.name + ' · ' + m.email, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })]), rowAction(true)]),
      frame({ name: 'status', dir: 'H', gap: 'space/2', align: 'center', wrap: true, rowGap: 'space/1', sizeH: 'FILL' }, [saBadge(r[3] || 'Awaiting review'), text(r[1] + ' · Since ' + r[2], 'Caption/Default', 'text/muted')]),
    ]));
  });
  const scr = phoneScreen(P1P3_NAME + ' (phone)', 'Admin', kids, null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- P3 Review a submission (ux.md 3.2 P3 and 3.2a, F16)
const P3_NAME = 'Admin · Seller review';
const P3_APP = { seller: 'sunnybank', business: 'Sunnybank Spice Market Pty Ltd', register: 'SUNNYBANK SPICE MARKET PTY LTD', abn: '51 824 753 556', street: '12 Mains Road', locality: 'Sunnybank', postcode: '4109', registerPostcode: '4110',
  phone: '0423 456 789', contact: 'hello@sunnybankspice.example', submission: '2', submitted: '6 Oct 2026, 9:40 AEST', queue: '2 days in the queue' };
// The approved seller behind the change request (the S2 to S6 sample values).
const P3_CHANGE = { seller: 'kuraby', business: SETUP.business, register: 'KURABY FRESH PTY LTD', abn: SETUP.abn, street: SETUP.street, locality: SETUP.locality, postcode: SETUP.postcode, registerPostcode: SETUP.postcode, phone: SETUP.phone };
const STORE_CHECK = 'Store name makes no certification claim and doesn’t imitate another brand.';
const MANUAL_CHECK = 'Record a manual register check';
// Market-configured checks (samples, except the store-name check, which ux.md names): [label, required]
const P3_CHECKS = [[STORE_CHECK, true], ['Business name matches the official register', true], ['Called the business phone number', false]];
const REGISTER = {
  active: ['Info', 'The official register lists this number as active.'], negative: ['Critical', 'The register doesn’t list this number as active.'], 'not-performed': ['Attention', 'Lookup not performed.'],
  unavailable: ['Attention', 'The register couldn’t be reached.'], stale: ['Attention', 'The last lookup is out of date.'], none: ['Info', 'This Market has no register lookup. Record a manual check.'] };
const APPROVE_BLOCK = { 'checks-missing': 'Record 2 required checks first.', 'register-blocks': 'Approve is unavailable while the register result is negative.', 'register-lookup': 'Look it up again or record a manual check first.',
  'not-current-revision': 'This isn’t the current submission.', 'identifier-held': 'Another approved or suspended seller already holds this number.', 'decision-in-progress': 'A decision is being recorded.' };
// The register banner and what goes with it: "Look up again" with the time of the last lookup, or the manual link (admins only, server-built, new tab).
function registerBlock(state) {
  const r = REGISTER[state];
  const kids = [saBanner(r[0], r[1], null, 'register-banner')];
  const tools = state === 'none' ? [] : [inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Look up again', 'Leading icon': true, Icon: { icon: 'refresh-cw' } }, { name: 'look-up-again' })];
  if (state === 'active' || state === 'negative') tools.push(saLine('Looked up on 6 Oct 2026, 9:41 AEST', 'looked-up'));
  if (state === 'not-performed' || state === 'unavailable' || state === 'stale' || state === 'none') tools.push(linkBtn('Open the register’s search page', 'external-link', 'manual-link'));
  kids.push(frame({ name: 'register-tools', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, tools));
  return frame({ name: 'register', dir: 'V', gap: 'space/3', pad: [0, 'space/5', 'space/3', 'space/5'], sizeH: 'FILL' }, kids);
}
function compareRow(label, value, register, flag, note, changed) { return saRow({ label: label, value: value, compare: register, valueLabel: 'Seller entered', compareLabel: 'Official register', flag: flag, note: note, state: changed ? 'Changed' : 'Default' }); }
function registerCard(o) {
  const a = o.change ? P3_CHANGE : P3_APP; const m = SA_SELLERS[a.seller]; const nc = FLAG.notCompared;
  const rows = [];
  if (o.register === 'active') {
    rows.push(compareRow('Business name', a.business, a.register, FLAG.matches, null, !o.change));
    rows.push(compareRow(SETUP.taxQuestion, 'Yes, from ' + SETUP.taxFrom, 'Registered from ' + SETUP.taxFrom, FLAG.matches));
    rows.push(a.postcode === a.registerPostcode ? compareRow('Postcode', a.postcode, a.registerPostcode, FLAG.matches) : compareRow('Postcode', a.postcode, a.registerPostcode, FLAG.differs, 'Differs from the register. Check before you approve.'));
  } else rows.push(saRow({ label: 'Business name', value: a.business, flag: nc, state: o.change ? 'Default' : 'Changed' }));
  rows.push(saRow({ label: 'Store name', value: m.store, flag: nc }), saRow({ label: SETUP.idLabel, value: a.abn, flag: nc }), saRow({ label: 'Operating address', value: a.street + ', ' + a.locality + ' ' + SETUP.region + ' ' + a.postcode, flag: nc }),
    saRow({ label: 'Phone', value: a.phone, flag: nc }), saRow({ label: 'Shop web address', value: SETUP.storefront + m.slug, flag: nc }));
  return card('Details against the register', [header('Details against the register', null), registerBlock(o.register)].concat(rows, [
    frame({ name: 'disclaimer', dir: 'H', pad: ['space/3', 'space/5', 'space/4', 'space/5'], sizeH: 'FILL' }, [saLine('A match doesn’t prove the applicant controls the business.', 'disclaimer-text')])]));
}
// o.checks: per check [value, state] in P3_CHECKS order; o.manual adds the manual register check; o.readOnly for a withdrawn or decided submission.
function checksCard(o) {
  const rows = P3_CHECKS.map(function (c, i) {
    const s = (o.checks || [])[i] || ['Unchecked', 'Default']; const rec = s[0] === 'Checked' && s[1] !== 'Saving';
    return reviewCheck({ label: c[0], required: c[1], value: s[0], state: o.readOnly ? 'Read-only' : s[1], desc: rec ? SA_RECORDED : SA_NOT_RECORDED, undo: rec && !o.readOnly });
  });
  if (o.manual) rows.push(reviewCheck({ label: MANUAL_CHECK, required: true, desc: 'Check the number on the register’s search page, then record it here.' }));
  const done = (o.checks || []).filter(function (s) { return s[0] === 'Checked' && s[1] !== 'Saving'; }).length;
  return card('Checks', [frame({ name: 'card-header', dir: 'H', justify: 'between', align: 'center', pad: [16, 18, 12, 18], sizeH: 'FILL' }, [text('Checks', 'Heading/H2'), text(done + ' of ' + rows.length + ' recorded', 'Body/Small', 'text/muted', { name: 'progress' })])].concat(rows));
}
function changesCard() {
  return card('Changes since the last submission', [header('Changes since the last submission', null), saRow({ label: 'Business name', value: P3_APP.business, state: 'Changed', note: 'Before: Sunnybank Spice Pty Ltd' })]);
}
function historyCard(events, empty) {
  const body = empty ? [saLine(empty, 'empty')] : events.map(function (e) { const p = { Tone: e[0], Who: e[1], What: e[2], When: e[3], 'Show quote': !!e[4] }; if (e[4]) p.Quote = e[4]; return inst('TimelineItem', p, { sizeH: 'FILL' }); });
  return card('History', [header('History', null), frame({ name: 'events', dir: 'V', pad: [0, 18, 6, 18], sizeH: 'FILL' }, body)]);
}
const P3_HISTORY = [['Teal', 'Hana Yusuf', 'submitted again', P3_APP.submitted], ['Blue', SA_REVIEWER, 'asked for changes', '3 Oct 2026, 11:05 AEST', 'Use the legal name of your business, then submit again.'],
  ['Teal', 'Hana Yusuf', 'submitted the application', '29 Sep 2026, 9:40 AEST']];
function sideCard(title, kids) { return card(title, [header(title, null), frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 18, 18, 18], sizeH: 'FILL' }, kids)]); }
function otherSellers(list) {
  if (!list.length) return [saLine('None found.', 'none')];
  return list.map(function (o) { return frame({ name: o[0], dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [frame({ name: 'seller', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(o[0], 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), saBadge(o[1])]), linkBtn('Open', null, 'open')]); });
}
function p3Side(o) {
  return frame({ name: 'Side', dir: 'V', gap: 'space/4', w: 360 }, [
    sideCard('Status', [saBadge(o.status || 'Awaiting review'), readOnlyPair('Email confirmed', 'Yes'), readOnlyPair('Time in the queue', o.queue || P3_APP.queue)]),
    sideCard('Service area and time zone', [readOnlyPair('Service area', 'Greater Brisbane'), readOnlyPair('Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')')]),
    sideCard('Other sellers with this ' + SETUP.idLabel, otherSellers(o.others || [])),
  ]);
}
// The decision buttons; a disabled Approve names the missing item beside it, in text (ux.md 3.2a).
function decisionButtons(o) {
  const approve = btn(o.change ? 'Approve change' : 'Approve', 'Primary', 'Md', { State: o.block || o.busy ? 'Disabled' : 'Default' });
  const reject = btn(o.change ? 'Reject change…' : 'Reject…', 'Destructive', 'Md', { State: o.busy ? 'Disabled' : 'Default' });
  return [reject, approve];
}
function blockReason(text_, link) {
  return frame({ name: 'decision-reason', dir: 'H', gap: 'space/1-5', align: 'center', justify: 'end', sizeH: 'FILL' }, [icon('info', 'icon/muted', 16), text(text_, 'Body/Small Strong', 'text/secondary', { name: 'reason-text' }), link ? linkBtn(link, null, 'reason-link') : null]);
}
// o: { register, checks, manual, block, change, withdrawn, others, history }
function tplP3(state, o) {
  const m = SA_SELLERS[o.change ? 'kuraby' : P3_APP.seller];
  const kind = bdg('Neutral', 'None', o.change ? 'Change request' : 'New application');
  const meta = 'Submission ' + (o.change ? '4' : P3_APP.submission) + ' · Submitted on ' + (o.change ? '7 Oct 2026, 8:15 AEST' : P3_APP.submitted) + ' · Submitted by the seller · ' + (o.change ? '1 day in the queue' : P3_APP.queue);
  const head = [backTo('Sellers'), pageTitle('Review ' + m.store, meta, o.withdrawn ? [] : decisionButtons(o), kind)];
  if (o.block) head.push(blockReason(APPROVE_BLOCK[o.block]));
  const kids = [frame({ name: 'Header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, head)];
  if (o.withdrawn) kids.push(saBanner('Info', 'This submission was withdrawn.', 'Back to sellers', 'withdrawn'));
  const main = [];
  if (o.change) main.push(card('Requested change', [header('Requested change', null), saRow({ label: 'Store name', value: SETUP.store, compare: 'Kuraby Fresh Grocers', valueLabel: 'Current', compareLabel: 'Requested', state: 'Changed' })]));
  main.push(registerCard(o), checksCard(o));
  if (!o.change) main.push(changesCard());
  main.push(o.change ? historyCard([['Teal', 'Yusuf Karimi', 'asked to change the store name', '7 Oct 2026, 8:15 AEST'], ['Blue', SA_REVIEWER, 'approved the seller', '12 Mar 2026, 10:02 AEST']]) : historyCard(P3_HISTORY));
  kids.push(frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [frame({ name: 'Main column', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, main),
    p3Side({ others: o.others, status: o.change ? 'Approved' : (o.withdrawn ? 'Ready to submit' : 'Awaiting review'), queue: o.change ? '1 day' : null })]));
  return screen(P3_NAME + ' · ' + state, 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H, gap: 'space/5', pad: [24, 32, 40, 32] });
}
const P3_ALL_DONE = [['Checked', 'Default'], ['Checked', 'Default'], ['Unchecked', 'Default']];
const P3_OTHERS = [['Sunnybank Spice Co', 'Not approved']];
const P3_FRAMES = [
  ['Application', { register: 'active', checks: P3_ALL_DONE, others: P3_OTHERS }],
  ['Checks missing', { register: 'active', checks: [['Checked', 'Saving'], ['Unchecked', 'Default'], ['Unchecked', 'Default']], block: 'checks-missing', others: P3_OTHERS }],
  ['Register negative', { register: 'negative', checks: P3_ALL_DONE, block: 'register-blocks', others: [] }],
  ['Lookup not performed', { register: 'not-performed', checks: P3_ALL_DONE, manual: true, block: 'register-lookup', others: [] }],
  ['Change request', { register: 'active', checks: [['Checked', 'Default'], ['Checked', 'Default'], ['Unchecked', 'Default']], change: true, others: [] }],
  ['Withdrawn', { register: 'active', checks: P3_ALL_DONE, withdrawn: true, readOnly: true, others: P3_OTHERS }],
];
// Every register state of 3.2a: the banner, its tools and what it does to Approve.
const REGISTER_EFFECT = { active: 'Mismatches are flagged on the rows. Approve is allowed.', negative: 'Approve is disabled: "' + APPROVE_BLOCK['register-blocks'] + '" Reject is allowed.', 'not-performed': 'Approve is disabled until a lookup succeeds or a manual check is recorded: "' + APPROVE_BLOCK['register-lookup'] + '"',
  unavailable: 'As Lookup not performed.', stale: 'A result older than the maximum age (30 days) counts as not performed.', none: 'The Market has no register adapter; the manual link shows when the Market has one. Approve needs the manual check.' };
function tplP3Register() {
  return stateBoard(P3_NAME + ' · Register states', 'Seller review: register states', 'The banner at the top of "Details against the register" for each register state (ux.md 3.2a). Admins only; the register\'s values never reach a seller screen.', Object.keys(REGISTER), function (s) {
    return frame({ name: 'state', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [registerBlock(s), saLine(REGISTER_EFFECT[s], 'effect', 'text/secondary')]);
  });
}
function tplP3Blocked() {
  const links = { 'identifier-held': 'Open that seller' };
  return stateBoard(P3_NAME + ' · Approve disabled', 'Seller review: Approve disabled', 'Approve is disabled when the API\'s denial code says so; the missing item is text beside the button, never a tooltip (ux.md 3.2a). During a decision both buttons are disabled.', Object.keys(APPROVE_BLOCK), function (s) {
    const busy = s === 'decision-in-progress';
    return frame({ name: 'state', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [frame({ name: 'buttons', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, decisionButtons({ block: s, busy: busy })), blockReason(APPROVE_BLOCK[s], links[s])]);
  });
}

// ---- P2 Seller page (ux.md 3.2 P2, F18, C1 and P2-H)
const P2_NAME = 'Admin · Seller detail';
const P2_AI_HELP = 'Turns AI suggestions on or off for this shop. AI never decides approvals, certificates or payments.';
const C1_LOCK_ROLE = 'Your role can view these settings but not change them.';
const C1_LOCK_TYPES = 'Restricting types arrives with the product catalog.';
const C1_META = 'Changed by ' + SA_REVIEWER + ' on 6 Oct 2026';
function certSlot() { return frame({ name: 'certification-slot', dir: 'H', px: 'space/2', py: 'space/1', stroke: 'border/input', dash: [4, 4], radius: 'radius/pill' }, [text('Certificate chip (certification)', 'Caption/Default', 'text/muted')]); }
// C1 Admin-only settings: o.locked (role), o.state per row
function c1Rows(o) {
  o = o || {};
  const lock = o.locked ? { state: 'Locked', msg: C1_LOCK_ROLE } : {};
  return [
    settingRow({ label: 'Allowed product types', seg: ['All types', 'Only selected types'], state: 'Locked', msg: o.locked ? C1_LOCK_ROLE : C1_LOCK_TYPES }),
    settingRow(Object.assign({ label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true, meta: C1_META }, lock)),
    settingRow(Object.assign({ label: 'AI features', desc: P2_AI_HELP, off: true }, lock)),
  ];
}
function c1Card(o) {
  return card('Admin-only settings', [frame({ name: 'card-header', dir: 'V', gap: 'space/0-5', pad: [16, 18, 8, 18], sizeH: 'FILL' }, [text('Admin-only settings', 'Heading/H2'), text('The seller can’t change these.', 'Body/Small', 'text/muted', { name: 'subtitle' })])].concat(c1Rows(o)));
}
function businessCard(s) {
  return card('Business details', [header('Business details', null)].concat(s.rows.map(function (r) { return saRow({ label: r[0], value: r[1] }); })));
}
const P2_KURABY = { seller: 'kuraby', status: 'Seller approved', since: 'Approved on 12 Mar 2026, 10:02 AEST', rows: [['Store name', SETUP.store], ['Business name', SETUP.business], [SETUP.idLabel, SETUP.abn],
  ['Operating address', SETUP.street + ', ' + SETUP.locality + ' ' + SETUP.region + ' ' + SETUP.postcode], ['Phone', SETUP.phone], ['Contact email', SETUP.contact], ['Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'],
  ['Shop web address', SETUP.storefront + SETUP.slug], [SETUP.taxQuestion, 'Yes, from ' + SETUP.taxFrom], ['Created', '3 Mar 2026'], ['Origin', 'Self-registered']] };
const P2_MOOROOKA = { seller: 'moorooka', status: 'Not approved', since: 'Not approved on 5 Oct 2026, 15:20 AEST', rows: [['Store name', 'Moorooka Grocer'], ['Business name', 'Moorooka Grocer Pty Ltd'], [SETUP.idLabel, '83 914 562 007'],
  ['Operating address', '88 Beaudesert Road, Moorooka ' + SETUP.region + ' 4105'], ['Phone', '0431 222 908'], ['Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'], ['Shop web address', SETUP.storefront + 'moorooka-grocer'], ['Created', '28 Sep 2026'], ['Origin', 'Invited by MondaPac']],
  reason: 'The business details you gave don’t meet our requirements for new shops.' };
function p2Header(s, o) {
  const m = SA_SELLERS[s.seller];
  const edit = function () { return btn('Edit details', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'pencil' } }); };
  let actions = [];
  if (o.viewOnly || o.edit) actions = [];
  else if (s.status === 'Not approved') actions = [edit(), btn('Allow one more application', 'Primary', 'Md')];
  else actions = [edit(), btn('Change web address', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'globe' } }), btn('Correct time zone', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'clock' } })];
  const kids = [backTo('Sellers'), pageTitle(m.store, m.name + ' · ' + m.email, actions, frame({ name: 'badges', dir: 'H', gap: 'space/2', align: 'center' }, [saBadge(s.status), certSlot()]))];
  if (o.viewOnly) kids.push(text(SELLERS_VIEW_ONLY, 'Body/Small', 'text/muted', { name: 'view-only-help', sizeH: 'FILL' }));
  return frame({ name: 'Header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, kids);
}
function p2Side(s) {
  const kids = [saBadge(s.status), saLine(s.since, 'since', 'text/secondary')];
  if (s.reason) kids.push(inst('ReasonQuote', { Label: 'Reason sent to the seller', Reason: s.reason, Date: 'Written on 5 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }));
  kids.push(readOnlyPair('Decisions', s.reason ? '1 change request, 1 not approved' : '1 approval'), linkBtn('Open the last review', null, 'last-review'));
  return frame({ name: 'Side', dir: 'V', gap: 'space/4', w: 360 }, [sideCard('Status', kids)]);
}
function certificatesSlot() {
  return card('Certificates', [header('Certificates', null), frame({ name: 'slot', dir: 'H', pad: [0, 18, 18, 18], sizeH: 'FILL' }, [frame({ name: 'certification-slot', dir: 'H', px: 'space/3', py: 'space/4', stroke: 'border/input', dash: [4, 4], radius: 'radius/control', sizeH: 'FILL' }, [text('Slot for the certificates card (owned by certification)', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])])]);
}
// state: null, Edit, Not approved, View only, History
function tplP2(state) {
  const s = state === 'Not approved' ? P2_MOOROOKA : P2_KURABY; const view = state === 'View only', edit = state === 'Edit';
  const kids = [p2Header(s, { viewOnly: view, edit: edit })];
  if (!edit) kids.push(tabsBar([['Overview', null, state !== 'History'], ['History', null, state === 'History']]));
  let main;
  if (state === 'History') main = [p2History()];
  else if (edit) main = p2Edit();
  else main = [businessCard(s), c1Card({ locked: view }), certificatesSlot()];
  kids.push(frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [frame({ name: 'Main column', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, main), p2Side(s)]));
  return screen(P2_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H, gap: 'space/5', pad: [24, 32, 40, 32] });
}
// Edit an approved seller (F18 steps 1 and 2): the S2 to S5 fields, the checks and the register state of P3, one save that applies at once.
function p2Edit() {
  const checks = card('Checks', [header('Checks', null), reviewCheck({ label: STORE_CHECK, required: true, value: 'Checked', desc: SA_RECORDED, undo: true }), reviewCheck({ label: P3_CHECKS[1][0], required: true })]);
  const bar = setupBar({ primary: 'Save changes', secondary: 'Cancel', state: 'Dirty', disabled: true });
  return [saBanner('Info', 'Changes to business identity apply at once and the owner is emailed.', null, 'edit-banner'),
    setupCard('Business details', [setupField('Store name', { value: SETUP.store, helper: STORE_HELP }), setupField('Business name', { value: 'Kuraby Fresh Grocers Pty Ltd' }), setupField('Phone', { value: SETUP.phone }), setupField('Contact email', { value: SETUP.contact, optional: true })]),
    setupCard('Address and area', addressFields(false)), setupCard('Business number', [numberField('Matched')]),
    card('Register', [header('Details against the register', null), registerBlock('active')]), checks,
    frame({ name: 'save', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [blockReason('Record 1 required check first.'), saLine('Changes to business identity apply at once and the owner is emailed.', 'save-note', 'text/secondary'), bar])];
}
// P2-H: revisions with their values hidden until "Show values" (protected permission; each reveal is recorded).
function p2History() {
  const cols = [['Date', 220], ['Kind', 200], ['Author', 160], ['Result', 'fill']];
  const rows = [['12 Mar 2026, 10:02 AEST', 'Decision', 'Admin', 'Approved'], ['11 Mar 2026, 16:40 AEST', 'Submission', 'Seller', 'Submitted again'], ['6 Mar 2026, 11:05 AEST', 'Decision', 'Admin', 'Changes needed'], ['4 Mar 2026, 9:12 AEST', 'Submission', 'Seller', 'Submitted']];
  return card('History', [frame({ name: 'card-header', dir: 'H', gap: 'space/3', align: 'center', pad: [16, 18, 12, 18], sizeH: 'FILL' }, [text('History', 'Heading/H2'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), saLine('Viewing this is recorded.', 'reveal-notice'), btn('Show values', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'eye' } })]),
    headerRow(cols)].concat(rows.map(function (r) { return row([[text(r[0], 'Body/Default'), 220], [text(r[1], 'Body/Default'), 200], [text(r[2], 'Body/Default'), 160], [text(r[3], 'Body/Default'), 'fill']]); })));
}
const P2_BANNERS = { 'Invited, not accepted': ['Info', 'This seller hasn’t accepted the invitation yet.'], Suspended: ['Critical', 'This seller is suspended.', 'View reason'],
  'Needs a check': ['Critical', 'This seller is approved but has no reviewed details. They can’t sell until this is checked.'], 'Decision under way': ['Attention', 'A decision is being recorded for this seller. Refresh in a moment.'] };
const P2_EDIT_BANNERS = { Approved: ['Info', 'Changes to business identity apply at once and the owner is emailed.'], 'Awaiting review': ['Attention', 'Saving withdraws the pending submission.'],
  Suspended: ['Attention', 'This seller is suspended. Your edit changes business data only.'], Invited: ['Info', 'This seller hasn’t accepted the invitation yet. Your edit changes their saved details.'],
  'Only seller.edit': ['Attention', 'You also need permission to approve identity changes.'], 'Change pending': ['Attention', 'A change request is waiting. Decide it first.', 'Open the request'] };
function tplP2Banners() { return stateBoard(P2_NAME + ' · Banners', 'Seller page: banners', 'One banner under the summary bar by the seller\'s state (ux.md 3.2 P2, F18 step 7). "Needs a check" has no action until a mini-review designs one.', Object.keys(P2_BANNERS), function (s) { const b = P2_BANNERS[s]; return saBanner(b[0], b[1], b[2]); }); }
function tplP2EditBanners() { return stateBoard(P2_NAME + ' · Edit banners', 'Seller page: edit banners', 'The banner at the top of the edit form (F18 steps 1 and 2). With only the edit permission, Save stays disabled with the same text beside it and nothing is sent.', Object.keys(P2_EDIT_BANNERS), function (s) { const b = P2_EDIT_BANNERS[s]; return saBanner(b[0], b[1], b[2]); }); }
const C1_STATES = { Default: { label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true }, Saving: { label: 'Category proposals', desc: 'Lets this seller suggest categories.', state: 'Saving' },
  'Saved, with who and when': { label: 'AI features', desc: P2_AI_HELP, meta: C1_META }, 'Locked by role': { label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true, state: 'Locked', msg: C1_LOCK_ROLE },
  'Locked until the catalog': { label: 'Allowed product types', seg: ['All types', 'Only selected types'], state: 'Locked', msg: C1_LOCK_TYPES }, 'Save failed': { label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true, state: 'Error' } };
function tplC1States() { return stateBoard(P2_NAME + ' · Admin-only settings states', 'Admin-only settings: row states', 'Each row saves on its own after a confirm dialog (F19). A failed save puts the old value back and says so; a locked row gives its reason in text.', Object.keys(C1_STATES), function (s) { return settingRow(C1_STATES[s]); }); }

// ---- P4 Seller settings (Market; ux.md 3.2 P4, F20)
const P4_NAME = 'Shared · Settings · Seller settings';
function p4Row(o) { return settingRow(Object.assign({ label: 'Require approval for new sellers', desc: 'New sign-ups wait for a person to approve them.', meta: C1_META }, o || {})); }
function tplP4(state) {
  const view = state === 'View only';
  return screen(P4_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-settings', 'Settings', [
    pageTitle('Seller settings', SA_MARKET, []),
    frame({ name: 'content', dir: 'V', gap: 'space/3', w: 'size/form-max' }, [card('Seller settings', [p4Row(view ? { state: 'Locked', msg: C1_LOCK_ROLE } : null)]), saLine('Applies to new sign-ups in ' + SA_MARKET + ' only.', 'market-note')]),
  ], { minH: PANEL_MIN_H });
}
function tplP4States() {
  const st = { Default: {}, Saving: { state: 'Saving', off: true }, 'Locked (view only)': { state: 'Locked', msg: C1_LOCK_ROLE }, 'Save failed': { state: 'Error' } };
  return stateBoard(P4_NAME + ' · States', 'Seller settings: states', 'Turning approval off opens a destructive confirm dialog with its consequences; turning it on, a plain one (ux.md 3.4). A failed save puts the old value back.', Object.keys(st), function (s) { return p4Row(st[s]); });
}

// ---- Dialogs (ux.md 3.4): D3 uses, D4 modes, D7, D8, D9, D10
const PREPARED = 'Business details incomplete';
const PREPARED_TEXT = 'Some of the business details you gave are incomplete. Check them and submit again.';
function preparedSelect(state, value) { return panelField('Prepared reason', { select: { state: state, value: value } }); }
function preview(label, value) { return frame({ name: 'preview', dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(label, 'Caption/Default', 'text/muted'), text(value, 'Body/Default', 'text/primary', { name: 'preview-text', sizeH: 'FILL' })]); }
function bodyRejectApplication() {
  const ta = S.sets.Textarea.set.children.filter(function (c) { return c.name === 'State=Default'; })[0];
  const f = inst('Field', { Label: 'Reason for the seller', Helper: REASON_HELP + ' Don’t copy values from the official register.', 'Show helper': true, 'Show counter': true, Counter: REASON_COUNTER, 'Show error': false, Control: { comp: ta } }, { name: 'field-reason-for-the-seller', sizeH: 'FILL' });
  return [preparedSelect('Default', 'Choose a prepared reason (optional)'), f];
}
function bodyRejectBulk() { return [preparedSelect('Filled', PREPARED), preview('The shop owner sees the text of this reason.', PREPARED_TEXT)]; }
function bodyRejectChange() { return [preparedSelect('Filled', 'Store name not accepted'), preview('The shop owner sees the text of this reason.', 'We couldn’t accept this store name. Use the name customers know your shop by.')]; }
function bodyBulkResult() {
  const count = function (ic, token, s) { return frame({ name: s, dir: 'H', gap: 'space/2', align: 'center' }, [icon(ic, token, 16), text(s, 'Body/Strong')]); };
  const item = function (store, why) { return frame({ name: store, dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(store, 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), text(why, 'Body/Small', 'text/secondary', { sizeH: 'FILL' })]); };
  return [frame({ name: 'counts', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [count('check', 'status/success/fg', '1 done'), count('minus', 'icon/muted', '1 skipped'), count('x', 'status/critical/fg', '1 refused')]),
    text('Skipped: no current submission, or a decision is under way.', 'Body/Small', 'text/muted', { name: 'skipped-help', sizeH: 'FILL' }),
    item('Darra Asian Mart', 'Skipped: this isn’t the current submission.'), item('Logan Family Grocer', 'Refused: record 2 required checks first.')];
}
function bodySlug() { return [readOnlyPair('Current address', SETUP.storefront + SETUP.slug), setupField('Shop web address', { value: 'kuraby-fresh-grocers', prefix: SETUP.storefront, helper: SLUG_HELP, status: ['Success', 'Available now.'] }), saBanner('Attention', 'The old address is retired and can never be used again.', null, 'warning')]; }
function bodyZone() { return [readOnlyPair('Current time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'), panelField('Time zone', { select: { state: 'Filled', value: 'Sydney time (Australia/Sydney)' }, helper: 'This changes cut-off and expiry times for this seller. The change is recorded.' })]; }
function bodyConfirmYou() { return [text('Enter your password to change your business details.', 'Body/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' }), authField('Password', { type: 'Password', filled: true }), authField('6-digit code', { type: 'Code', filled: true })]; }
function tplDialogsReview() {
  const b4 = tplBody('Template body · D4 Reject (application)', bodyRejectApplication);
  const b4b = tplBody('Template body · D4 Reject (bulk)', bodyRejectBulk);
  const b4c = tplBody('Template body · D4 Reject (change request)', bodyRejectChange);
  const b10 = tplBody('Template body · D10 Bulk result', bodyBulkResult);
  return tallScene('Dialogs · Seller review · Admin', [
    confirmDlg('D3 Approve', 'Approve this seller?', SA_SELLERS.sunnybank.store + ' gets full access to the seller panel and an email.', 'Approve seller'),
    confirmDlg('D3 Approve change', 'Approve this change?', 'The new details go live at once and the owner is emailed.', 'Approve change'),
    confirmDlg('D3 Approve selected', 'Approve 3 sellers?', 'Sellers without a current submission are skipped.', 'Approve 3 sellers'),
    dlg({ name: 'D4 Reject (application)', size: 'Md', tone: 'Destructive', title: 'Reject this application?', primary: 'Reject application', secondary: 'Cancel', content: b4, focusCancel: true }),
    dlg({ name: 'D4 Reject (bulk)', size: 'Md', tone: 'Destructive', title: 'Reject 3 applications?', primary: 'Reject 3 applications', secondary: 'Cancel', content: b4b, focusCancel: true }),
    dlg({ name: 'D4 Reject (change request)', size: 'Md', tone: 'Destructive', title: 'Not accept this change?', primary: 'Not accept change', secondary: 'Cancel', content: b4c, focusCancel: true }),
    dlg({ name: 'D10 Bulk result', title: 'Result', primary: 'Close', hideSecondary: true, content: b10 }),
  ]);
}
function tplDialogsDetail() {
  const b7 = tplBody('Template body · D7 Change shop web address', bodySlug);
  const b8 = tplBody('Template body · D8 Correct time zone', bodyZone);
  return tallScene('Dialogs · Seller detail · Admin', [
    confirmDlg('D3 Submit for this seller', 'Submit these details for this seller?', 'It’s recorded as submitted by MondaPac.', 'Submit for this seller'),
    confirmDlg('D3 Save and withdraw the submission', 'Save and withdraw the submission?', 'The pending submission leaves the review queue and the owner is told.', 'Save and withdraw'),
    confirmDlg('D3 Allow one more application', 'Allow one more application?', 'The owner can submit again and is emailed.', 'Allow one more application'),
    dlg({ name: 'D7 Change shop web address', size: 'Md', title: 'Change shop web address', primary: 'Change address', secondary: 'Cancel', content: b7 }),
    dlg({ name: 'D8 Correct time zone', title: 'Correct time zone', primary: 'Correct time zone', secondary: 'Cancel', content: b8 }),
  ]);
}
function tplDialogsSettings() {
  return tallScene('Dialogs · Seller settings · Admin', [
    confirmDlg('D3 Restrict product types', 'Only allow selected types?', 'Offers of a type that’s no longer allowed are taken off sale.', 'Only allow selected types', { tone: 'Destructive' }),
    confirmDlg('D3 Turn off category proposals', 'Turn off category proposals?', 'Suggestions waiting for a decision are closed.', 'Turn off', { tone: 'Destructive' }),
    confirmDlg('D3 Turn on AI features', 'Turn on AI features?', 'We’ll email the shop owner that AI is on for their shop.', 'Turn on'),
    confirmDlg('D3 Turn off approval', 'Turn off approval?', 'New sign-ups in ' + SA_MARKET + ' won’t need a person to approve them. A seller whose details are complete, and whose business number the register lists as active with no differences, is approved automatically. Everyone else still goes to a person. Sellers already waiting aren’t approved.', 'Turn off approval', { tone: 'Destructive', size: 'Md' }),
    confirmDlg('D3 Require approval', 'Require approval?', 'New sign-ups will wait for approval.', 'Require approval'),
  ]);
}
function tplDialogsSellerDetails() {
  const b9 = tplBody('Template body · D9 Confirm it’s you', bodyConfirmYou);
  return tallScene('Dialogs · Seller details · Seller', [
    dlg({ name: 'D9 Confirm it’s you', title: 'Confirm it’s you', primary: 'Continue', secondary: 'Cancel', content: b9 }),
    confirmDlg('D3 Cancel change request', 'Cancel this request?', 'Your current details stay as they are.', 'Cancel request', { tone: 'Destructive', secondary: 'Keep request' }),
    confirmDlg('D3 Withdraw submission', 'Withdraw your submission?', 'It leaves MondaPac’s review queue. Your details stay saved.', 'Withdraw submission', { tone: 'Destructive' }),
    confirmDlg('D3 Save and withdraw', 'Save and withdraw your submission?', 'Your details will be saved and your submission withdrawn. Submit again when you’re ready.', 'Save and withdraw'),
  ]);
}
function tplSheetConfirmYou() {
  const b9 = tplBody('Template body · D9 Confirm it’s you', bodyConfirmYou);
  return sheetScene('Dialog sheet · Confirm it’s you (phone)', dlg({ name: 'D9 Confirm it’s you (sheet)', layout: 'Sheet', title: 'Confirm it’s you', primary: 'Continue', secondary: 'Cancel', content: b9 }));
}

// ---- S7 Store profile (ux.md 3.1 S7 and 3.1a, F21), full seller shell
const S7_NAME = 'Seller · Store profile';
const S7_REQUESTED = 'Kuraby Fresh Grocers';
const S7_REJECTED = 'We couldn’t accept this store name. Use the name customers know your shop by.';
const PLAIN_TEXT = 'Plain text only. Web addresses and formatting are shown as typed.';
// The AU Market's sample money values: the currency code and tax phrase come from Market configuration, amounts are formatted with Intl.
const MIN_CURRENCY = 'AUD';
const MIN_MONEY = { saved: 'A$50.00', latest: 'A$40.00', example: 'A$25.00' };
const MIN_UNIT = 'Amount in ' + MIN_CURRENCY + ', including GST';
const ACTING_AS = 'You’re signed in as this seller. Edit their details from the seller’s page.';
const MIN_APPLIES = 'Customers can’t check out your items with less than this. Shipping isn’t counted. A change applies at once, including to open carts.';
function s7Field(label, value, o) {
  o = o || {};
  if (!o.area) return setupField(label, { value: value, helper: o.helper, optional: o.optional, state: o.readOnly ? 'Disabled' : null });
  const ta = S.sets.Textarea.set.children.filter(function (c) { return c.name === (o.readOnly ? 'State=Disabled' : (value ? 'State=Filled' : 'State=Default')); })[0];
  const p = { Label: label, Helper: o.helper || PLAIN_TEXT, 'Show helper': true, 'Show counter': true, Counter: o.counter || (value.length + ' / 2000'), 'Show error': false, Control: { comp: ta } };
  const f = inst('Field', p, { name: 'field-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), sizeH: 'FILL' });
  if (value) setNested(f, 'control', prop('Textarea', 'Value', value));
  return f;
}
function saveBar(state) { return setupBar({ primary: 'Save', secondary: null, state: state || 'Clean' }); }
// The identity rows: owner (Request a change), Staff (the reason instead), pending or not accepted (the store name as a Compare row).
const S7_OWNER_ONLY = 'Only the shop owner can change these details.';
const S7_PENDING = 'Another change request is waiting. Cancel it or wait for the decision.';
// A DataRow "Request a change" that is disabled, with its reason as the row's note.
function askOff(r) { setNested(r, 'action', { State: 'Disabled' }); return r; }
function identityRows(o) {
  const ask = o.readOnly ? null : 'Request a change'; const off = o.staff || o.pending; const note = o.staff ? S7_OWNER_ONLY : (o.pending ? S7_PENDING : null);
  let store;
  if (o.pending) store = saRow({ label: 'Store name', value: SETUP.store, compare: S7_REQUESTED, valueLabel: 'Current', compareLabel: 'Requested', flag: FLAG.waiting, action: 'Cancel request', note: 'Your current details stay in use until MondaPac reviews this.' });
  else if (o.notAccepted) store = saRow({ label: 'Store name', value: SETUP.store, compare: S7_REQUESTED, valueLabel: 'Current', compareLabel: 'Requested', flag: FLAG.notAccepted, action: 'Request a change', note: S7_REJECTED });
  else store = saRow({ label: 'Store name', value: SETUP.store, action: ask, note: note, narrow: o.narrow });
  const rows = [saRow({ label: 'Business name', value: SETUP.business, action: ask, note: note, narrow: o.narrow }), saRow({ label: SETUP.idLabel, value: SETUP.abn, action: ask, note: note, narrow: o.narrow })];
  if (off && ask) { if (o.staff) askOff(store); rows.forEach(askOff); }
  return [store].concat(rows);
}
function s7General(o) {
  const kids = [header('General', null), frame({ name: 'locked-note', dir: 'H', pad: [0, 'space/5', 'space/2', 'space/5'], sizeH: 'FILL' }, [saLine('These details need a review before they change.', 'identity-note')])].concat(identityRows(o));
  if (o.readOnly) kids.push(saRow({ label: 'Phone', value: SETUP.phone, narrow: o.narrow }), saRow({ label: 'Contact email', value: SETUP.contact, narrow: o.narrow }));
  kids.push(saRow({ label: 'Sign-in email', value: SETUP.signIn, note: 'To change it, contact us.', narrow: o.narrow }));
  if (!o.readOnly) {
    const form = [setupField('Phone', { value: SETUP.phone }), setupField('Contact email', { value: SETUP.contact, optional: true, helper: CONTACT_HELP })];
    if (o.ai) form.push(saLine('AI is on for your shop.', 'ai-on', 'text/secondary'));
    if (!o.narrow) form.push(saveBar());
    kids.push(frame({ name: 'body', dir: 'V', gap: 'space/4', pad: ['space/4', 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, form));
  }
  return card('General', kids);
}
function s7Address(o) {
  const ask = o.readOnly ? null : 'Request a change';
  const where = saRow({ label: 'Where your shop works from', value: SETUP.street + ', ' + SETUP.locality + ' ' + SETUP.region + ' ' + SETUP.postcode, action: ask, note: o.staff ? S7_OWNER_ONLY : (o.pending ? S7_PENDING : null), narrow: o.narrow });
  if (ask && (o.staff || o.pending)) askOff(where);
  return card('Address', [header('Address', null), where,
    saRow({ label: 'Work time zone', value: SETUP.zone + ' (' + SETUP.zoneId + ')', note: 'To change this, contact us.', narrow: o.narrow }), saRow({ label: 'Shop web address', value: SETUP.storefront + SETUP.slug, note: 'To change this, contact us.', narrow: o.narrow })]);
}
const S7_TEXTS = { description: 'Fresh lamb, beef and poultry, cut to order in Kuraby since 2009. Order by 2 pm for same-day pickup.', policies: 'Unopened items can be returned within 7 days. Chilled items can’t be returned once collected.' };
function s7Texts(o) {
  const ro = o.readOnly;
  const cards = [];
  if (o.langs) cards.push(tabsBar([['English', null, true], ['Persian', null, false]]));
  cards.push(setupCard('Description', [s7Field('Shop description', S7_TEXTS.description, { area: true, readOnly: ro })]),
    setupCard('Policies', [s7Field('Returns and refunds', S7_TEXTS.policies, { area: true, readOnly: ro })]),
    setupCard('SEO', [s7Field('Search title', 'Kuraby Fresh: fresh meat in Kuraby', { readOnly: ro }), s7Field('Keywords', 'lamb, beef, chicken, Kuraby', { readOnly: ro }), s7Field('Search description', 'Fresh lamb, beef and poultry, cut to order.', { area: true, counter: '43 / 160', readOnly: ro })]),
    setupCard('Social', [s7Field('Instagram', 'https://instagram.com/kurabyfresh', { helper: 'Links to facebook.com, instagram.com or youtube.com only.', readOnly: ro }), s7Field('Facebook', '', { optional: true, readOnly: ro })]));
  if (!ro) cards.push(saveBar('Dirty'));
  return frame({ name: 'texts', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, cards);
}
function s7Tax(o) { return card('Tax registration', [header('Tax registration', null), saRow({ label: SETUP.taxQuestion, value: 'Yes, from ' + SETUP.taxFrom, action: o.readOnly ? null : 'Record a change', note: 'MondaPac doesn’t decide whether you must register.' })]); }
// The Settings card: the minimum order in each state of 3.1a.
const MIN_STATES = ['None', 'Set', 'Dirty', 'Saving', 'Removed', 'Invalid amount', 'Wrong currency', 'Save conflict', 'Load error', 'No edit permission', 'Acting-as'];
function minField(value, error) { return setupField('Minimum order (optional)', { value: value, prefix: MIN_CURRENCY, helper: error ? null : MIN_UNIT, error: error }); }
function minOrder(state) {
  const kids = [];
  if (state === 'Load error') return [saBanner('Critical', 'We couldn’t load this card.', 'Try again', 'load-error')];
  if (state === 'No edit permission') return [saRow({ label: 'Minimum order', value: MIN_MONEY.saved })];
  if (state === 'Acting-as') return [saBanner('Attention', ACTING_AS, null, 'acting-as'), saRow({ label: 'Minimum order', value: MIN_MONEY.saved })];
  if (state === 'Invalid amount') kids.push(saBanner('Critical', 'Check the details below', null, 'error-summary'));
  if (state === 'Wrong currency') kids.push(saBanner('Attention', 'This amount isn’t in ' + MIN_CURRENCY + '. Reload the page and try again.', 'Reload', 'currency'));
  if (state === 'Save conflict') kids.push(saBanner('Attention', 'This setting was changed somewhere else. The latest value is ' + MIN_MONEY.latest + '. Check it and save again.', null, 'conflict'));
  const value = { None: '', Removed: '', Dirty: '60.00', Saving: '60.00', 'Invalid amount': '0', 'Save conflict': '60.00', 'Wrong currency': '60' }[state];
  kids.push(minField(value === undefined ? '50.00' : value, state === 'Invalid amount' ? 'Enter an amount greater than zero, for example ' + MIN_MONEY.example + '.' : null), setupNote(MIN_APPLIES, 'applies'));
  if (state === 'None' || state === 'Removed') kids.push(setupNote('No minimum. Customers can order any amount.', 'none'));
  else kids.push(frame({ name: 'current', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [saLine('Current minimum: ' + (state === 'Save conflict' ? MIN_MONEY.latest : MIN_MONEY.saved), 'current-text', 'text/secondary'), linkBtn('Remove minimum', null, 'remove')]));
  const bar = { None: ['Clean', true, true], Set: ['Clean'], Dirty: ['Dirty'], Saving: ['Saving'], Removed: ['Clean'], 'Invalid amount': ['Error'], 'Wrong currency': ['Dirty'], 'Save conflict': ['Dirty'] }[state];
  kids.push(setupBar({ primary: 'Save', secondary: null, state: bar[0], disabled: bar[1], noStatus: bar[2] }));
  if (state === 'Removed') kids.push(inst('Toast', { Tone: 'Success', Message: 'Minimum removed.', 'Show action': false }, { name: 'Toast' }));
  return kids;
}
function s7Settings(o) { return setupCard('Settings', o.readOnly ? minOrder('No edit permission') : minOrder('None')); }
// o: { pending, notAccepted, staff, readOnly, langs, ai }
function s7Content(o) {
  const kids = [pageTitle('Store profile', null, [])];
  if (o.readOnly) kids.push(saBanner('Info', 'You can view this page but not change it.', null, 'view-only'));
  kids.push(s7General(o), s7Address(o), s7Texts(o), s7Tax(o), s7Settings(o));
  return kids;
}
function shopSwitcher(scr) { // the sample shop name of 1.10.0 frames, also in a file whose Sidebar still has an older sample
  const t = scr.findOne(function (n) { return n.type === 'TEXT' && n.parent && n.parent.name === 'button' && n.parent.parent && n.parent.parent.name === 'shop-switcher'; });
  if (t && t.characters !== SETUP.store) t.characters = SETUP.store;
}
function tplS7(state, o) {
  const scr = screen(S7_NAME + (state ? ' · ' + state : ''), 'Seller', 'nav-settings', 'Store profile', [frame({ name: 'content', dir: 'V', gap: 'space/5', w: 760 }, s7Content(o || {}))], { minH: PANEL_MIN_H });
  shopSwitcher(scr);
  return scr;
}
function tplS7Min() { return stateBoard(S7_NAME + ' · Minimum order states', 'Store profile: minimum order', 'The Settings card in each state of ux.md 3.1a. The prefix is the Market\'s ISO currency code, never a bare "$"; amounts are formatted with Intl in the page locale. No view permission is B5, as for the whole page.', MIN_STATES, function (s) { return frame({ name: 'card-body', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, minOrder(s)); }); }
function tplS7Phone() {
  const o = { narrow: true };
  const scr = phoneScreen(S7_NAME + ' (phone)', 'Seller', [text('Store profile', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), s7General(o), s7Address(o), s7Settings(o)], 'More');
  applyDensity(scr, 'touch');
  return scr;
}

// ---- the list of 1.10.0 frames: [group, name, make]
// At most six desktop frames per row, so Templates · Admin keeps the width the earlier rows gave it; the admin state boards share one row.
const SELLER_ADMIN_ROWS = ['sa-sellers', 'sa-review', 'sa-detail', 'sa-settings', 'sa-boards', 'sa-profile', 'sa-dialogs', 'sa-phone'];
function sellerAdminDefs() {
  const p1 = function (s) { return ['sa-sellers', P1P3_NAME + (s ? ' · ' + s : ''), function () { return tplP1P3(s); }]; };
  const p2 = function (s) { return ['sa-detail', P2_NAME + (s ? ' · ' + s : ''), function () { return tplP2(s); }]; };
  return {
    'tpl-admin': [p1(null), p1('Selected'), p1('Selection limit'), p1('Incomplete'), p1('Approved'), p1('View only'), ['sa-boards', P1P3_NAME + ' · Empty states', tplP1P3Empty]]
      .concat(P3_FRAMES.map(function (f) { return ['sa-review', P3_NAME + ' · ' + f[0], function () { return tplP3(f[0], f[1]); }]; }), [
        ['sa-boards', P3_NAME + ' · Register states', tplP3Register], ['sa-boards', P3_NAME + ' · Approve disabled', tplP3Blocked],
        p2(null), p2('Edit'), p2('Not approved'), p2('View only'), p2('History'),
        ['sa-boards', P2_NAME + ' · Banners', tplP2Banners], ['sa-boards', P2_NAME + ' · Edit banners', tplP2EditBanners], ['sa-boards', P2_NAME + ' · Admin-only settings states', tplC1States],
        ['sa-settings', P4_NAME, function () { return tplP4(null); }], ['sa-settings', P4_NAME + ' · View only', function () { return tplP4('View only'); }], ['sa-boards', P4_NAME + ' · States', tplP4States],
        ['sa-dialogs', 'Dialogs · Seller review · Admin', tplDialogsReview], ['sa-dialogs', 'Dialogs · Seller detail · Admin', tplDialogsDetail], ['sa-dialogs', 'Dialogs · Seller settings · Admin', tplDialogsSettings],
        ['sa-phone', P1P3_NAME + ' (phone)', tplP1P3Phone],
      ]),
    'tpl-seller': [
      ['sa-profile', S7_NAME, function () { return tplS7(null, { ai: true }); }], ['sa-profile', S7_NAME + ' · Pending change', function () { return tplS7('Pending change', { pending: true }); }],
      ['sa-profile', S7_NAME + ' · Not accepted', function () { return tplS7('Not accepted', { notAccepted: true }); }], ['sa-profile', S7_NAME + ' · Staff', function () { return tplS7('Staff', { staff: true }); }],
      ['sa-profile', S7_NAME + ' · View only', function () { return tplS7('View only', { readOnly: true }); }], ['sa-profile', S7_NAME + ' · Languages', function () { return tplS7('Languages', { langs: true }); }],
      ['sa-profile', S7_NAME + ' · Minimum order states', tplS7Min],
      ['sa-dialogs', 'Dialogs · Seller details · Seller', tplDialogsSellerDetails],
      ['sa-phone', S7_NAME + ' (phone)', tplS7Phone], ['sa-phone', 'Dialog sheet · Confirm it’s you (phone)', tplSheetConfirmYou],
    ],
  };
}
function sellerAdminNames(key) { return sellerAdminDefs()[key].map(function (d) { return d[1]; }); }
// The sets the 1.10.0 templates place (a template is built only when each one is the plugin's own).
const SELLER_ADMIN_TEMPLATE_NEEDS = ['Sidebar', 'Topbar', 'PhoneTopbar', 'BottomTabBar', 'Button', 'IconButton', 'Input', 'Field', 'FieldStatus', 'Select', 'Textarea', 'Badge', 'CountBadge', 'InfoBanner', 'CardHeader', 'TableCell',
  'Checkbox', 'CheckboxRow', 'SettingRow', 'SegmentedControl', 'Switch', 'Tab', 'FilterChip', 'IdentityTile', 'Menu', 'MenuItem', 'BulkActionBar', 'DataRow', 'FormActionBar', 'EmptyState', 'ReasonQuote', 'TimelineItem', 'Dialog', 'DialogBody', 'Toast'];
// Dark preview copies added in 1.10.0.
const DARK_1100 = [P3_NAME + ' · Application', S7_NAME + ' · Pending change'];

// ==== 50_main.js ====
// ---------------------------------------------------------------- pages & orchestration
const PAGES = [
  ['cover', 'Cover'], ['start', 'Getting started'], ['changelog', 'Changelog'],
  ['sep-foundations', '———— Foundations'], ['color', 'Colour'], ['type', 'Typography'], ['spacing', 'Spacing, size & radius'], ['elevation', 'Elevation & motion'], ['icons', 'Icons'], ['a11y', 'Accessibility'],
  ['sep-components', '———— Components'], ['actions', 'Actions'], ['forms', 'Forms & selection'], ['status', 'Status & feedback'], ['data', 'Data display'], ['tables', 'Tables & collections'], ['nav', 'Navigation & shell'], ['review', 'Review & detail'], ['board', 'Board & delivery'],
  ['sep-templates', '———— Templates'], ['tpl-admin', 'Templates · Admin'], ['tpl-seller', 'Templates · Seller'], ['tpl-auth', 'Templates · Auth'], ['tpl-dark', 'Templates · Dark preview'],
  ['sep-workspace', '———— Workspace'], ['sandbox', 'Sandbox'], ['archive', 'Archive'],
];
const COLLECTION_NAMES = ['Primitives', 'Color', 'Color · Dark', 'Dimension', 'Dimension · Touch', 'Typography', 'Motion'];

function post(msg) { try { figma.ui.postMessage(msg); } catch (e) { /* UI closed */ } }
let STEP = 0; let STEPS = 25;
function progress(label) { STEP++; post({ type: 'progress', step: STEP, total: STEPS, label: label }); }
function wait() { return new Promise(function (r) { setTimeout(r, 0); }); }

async function fileIsEmpty() {
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  const styles = (await figma.getLocalTextStylesAsync()).length + (await figma.getLocalEffectStylesAsync()).length + (await figma.getLocalPaintStylesAsync()).length;
  const pages = figma.root.children;
  const content = pages.some(function (p) { return p.children.length > 0; });
  return { empty: !content && pages.length === 1 && colls.length === 0 && styles === 0, hasLibrary: pages.some(function (p) { return p.getPluginData(PLUGIN_TAG) === 'page'; }) || colls.some(function (c) { return COLLECTION_NAMES.indexOf(c.name) >= 0; }) };
}

// Starter files allow 3 pages: the same content is grouped into canvas sections on 3 pages.
const COMPACT = [
  ['p-start', '1 · Start & foundations', 'H', ['cover', 'start', 'changelog', 'color', 'type', 'spacing', 'elevation', 'icons', 'a11y']],
  ['p-components', '2 · Components', 'H', ['actions', 'forms', 'status', 'data', 'tables', 'nav', 'review', 'board']],
  ['p-templates', '3 · Templates & workspace', 'V', ['tpl-admin', 'tpl-seller', 'tpl-auth', 'tpl-dark', 'sandbox', 'archive']],
];
const TITLE = {}; PAGES.forEach(function (d) { TITLE[d[0]] = d[1]; });

// Remove everything this plugin generated (pages, variable collections, styles). Other pages are kept.
async function resetLibrary() {
  const tagged = figma.root.children.filter(function (p) { return p.getPluginData(PLUGIN_TAG) === 'page'; });
  let keep = tagged[0];
  if (!keep) { try { keep = figma.createPage(); } catch (e) { throw new Error('No free page in this file (Starter files have 3). Use a new design file.'); } }
  await figma.setCurrentPageAsync(keep);
  keep.children.slice().forEach(function (n) { n.remove(); });
  tagged.slice(1).forEach(function (p) { p.remove(); });
  keep.name = 'Building…'; keep.setPluginData(PLUGIN_TAG, ''); keep.setPluginData('layout', '');
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  colls.forEach(function (c) { if (COLLECTION_NAMES.indexOf(c.name) >= 0) c.remove(); });
  const names = {}; SPEC.type.forEach(function (t) { names[t.name] = 1; }); SPEC.effects.forEach(function (e) { names[e.name] = 1; });
  (await figma.getLocalTextStylesAsync()).forEach(function (s) { if (names[s.name]) s.remove(); });
  (await figma.getLocalEffectStylesAsync()).forEach(function (s) { if (names[s.name]) s.remove(); });
  return keep;
}

function tryCreatePages(n) {
  const made = [];
  try { for (let i = 0; i < n; i++) made.push(figma.createPage()); return made; }
  catch (e) { made.forEach(function (p) { p.remove(); }); return null; }
}
function makeSection(page, key) {
  const s = figma.createSection(); page.appendChild(s);
  s.name = TITLE[key]; s.setPluginData(PLUGIN_TAG, 'section'); s.setPluginData('key', key);
  s.fills = [paint('bg/subtle')]; s.strokes = [paint('border/default')];
  return s;
}
// Returns T[key] = { page, host }: host is the page itself (full layout) or a section (Starter layout).
async function createLayout(first) {
  const T = {};
  const extra = tryCreatePages(PAGES.length - 1);
  if (extra) {
    [first].concat(extra).forEach(function (p, i) {
      const d = PAGES[i]; p.name = d[1]; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', d[0]); p.setPluginData('layout', 'full');
      figma.root.insertChild(i, p); T[d[0]] = { page: p, host: p };
    });
    return { T: T, compact: false };
  }
  const pages = [first].concat(tryCreatePages(COMPACT.length - 1) || []);
  if (pages.length < COMPACT.length) throw new Error('This file needs ' + COMPACT.length + ' free pages. Use a new design file.');
  COMPACT.forEach(function (d, i) {
    const p = pages[i]; p.name = d[1]; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', d[0]); p.setPluginData('layout', 'compact');
    figma.root.insertChild(i, p);
    d[3].forEach(function (k) { T[k] = { page: p, host: makeSection(p, k) }; });
  });
  log('ℹ Starter plan: 3 pages per file, so each topic is a section on the canvas. After upgrading, "Upgrade to modes" also splits sections into pages.');
  return { T: T, compact: true };
}
// Fit each section to its content and line the sections up (left to right, or top to bottom for templates).
function arrangeSections(T) {
  COMPACT.forEach(function (d) {
    let pos = 0;
    d[3].forEach(function (k) {
      const s = T[k].host; let w = 0, h = 0;
      s.children.forEach(function (c) { c.x += 80; c.y += 120; w = Math.max(w, c.x + c.width); h = Math.max(h, c.y + c.height); });
      s.resizeWithoutConstraints(Math.max(480, w + 80), Math.max(320, h + 96));
      if (d[2] === 'H') { s.x = pos; s.y = 0; pos += s.width + 240; } else { s.x = 0; s.y = pos; pos += s.height + 240; }
    });
  });
}

const UPDATE_TOUCHED = []; // pages Update library changed in this run (their overlaps are reported at the end)
async function onPage(target, label, fn) {
  await figma.setCurrentPageAsync(target.page);
  if (UPDATE_TOUCHED.indexOf(target.page) < 0) UPDATE_TOUCHED.push(target.page);
  const r = await fn(target.host);
  await flush();
  progress(label);
  await wait();
  return r;
}

// Lay out finished screens left to right under a short header.
function templatesPage(host, title, subtitle, screens) {
  const head = frame({ name: title, dir: 'V', gap: 'space/3', pad: [0, 0, 0, 0], w: 1200 }, [
    text('MondaPac Design System', 'Caption/Overline', 'text/link'), text(title, 'Display/Hero'), para(subtitle, 1100),
  ]);
  head.fills = []; host.appendChild(head); head.x = 0; head.y = 0; tag(head);
  let x = 0;
  // Figma labels top-level frames with their names, so no separate caption is needed.
  screens.forEach(function (s) {
    host.appendChild(s); s.x = x; s.y = 240;
    x += s.width + 160;
  });
}

function notePage(host, title, subtitle, items) {
  const root = pageShell(host, title, subtitle);
  add(root, bullets(items, 1100));
  tag(root);
}

async function build(force) {
  STEP = 0; STEPS = 26; S.report = []; S.sets = {}; PANEL_BODIES.length = 0; // a rebuild starts from no components (S.sets may hold nodes of the library that was just deleted)
  await figma.loadAllPagesAsync();
  const state = await fileIsEmpty();
  let first;
  if (!state.empty) {
    if (!force) { post({ type: 'error', message: state.hasLibrary ? 'This file already has the MondaPac library. Tick "Rebuild" to replace it.' : 'Run the build in a new, empty design file (or tick "Rebuild").' }); return; }
    first = await resetLibrary();
  } else first = figma.root.children[0];

  post({ type: 'status', label: 'Creating variables…' });
  await buildVariables(); progress('Variables'); await wait();
  await loadFonts(); await buildStyles(); await flush(); progress('Text and effect styles'); await wait();
  figma.root.setPluginData('version', SPEC.version);

  const L = await createLayout(first); const P = L.T;
  const iconsWrap = await onPage(P.icons, 'Icons', function (h) { return buildIcons(h); });

  await onPage(P.actions, 'Actions', buildActions);
  // Status & feedback first: CheckboxRow (Forms & selection, 1.8.0) places a Badge.
  await onPage(P.status, 'Status & feedback', buildStatus);
  await onPage(P.forms, 'Forms & selection', buildForms);
  await onPage(P.data, 'Data display', buildDataDisplay);
  await onPage(P.tables, 'Tables & collections', buildTables);
  await onPage(P.nav, 'Navigation & shell', buildNavigation);
  await onPage(P.review, 'Review & detail', buildReview);
  await onPage(P.board, 'Board & delivery', buildBoard);

  await onPage(P.icons, 'Icons page', function (h) { return pageIcons(h, iconsWrap); });
  await onPage(P.color, 'Colour', pageColor);
  await onPage(P.type, 'Typography', pageTypography);
  await onPage(P.spacing, 'Spacing', pageSpacing);
  await onPage(P.elevation, 'Elevation & motion', pageElevation);
  await onPage(P.a11y, 'Accessibility', pageA11y);
  await onPage(P.start, 'Getting started', pageGettingStarted);

  const adminScreens = await onPage(P['tpl-admin'], 'Admin templates', function (h) {
    const list = [tplAdminHome(), tplAdminSellers(), tplAdminReview(), tplAdminPhoneMenu()];
    templatesPage(h, 'Templates · Admin', 'Full screens built only from library instances. Copy a template to start a new Admin screen; never detach the shell.', list);
    addPanelTemplates(h, 'tpl-admin'); // 1.8.0 Panel: Members, Roles, No access, Account security, dialogs (one canvas row per group, below the first row)
    addPanelTemplates(h, 'tpl-admin', null, panel183Defs, PANEL183_ROWS); // 1.8.3: Sellers list (P1), role editor, dialogs D4 to D6, unsaved changes
    addPanelTemplates(h, 'tpl-admin', null, sellerAdminDefs, SELLER_ADMIN_ROWS); // 1.10.0 Seller admin: Sellers (Phase 3), Seller review, Seller detail, Seller settings, dialogs
    return list;
  });
  const sellerScreens = await onPage(P['tpl-seller'], 'Seller templates', function (h) {
    const list = [tplSellerHome(), tplSellerOrders(), tplSellerBoard(), tplSellerPhoneHome(), tplSellerPhoneMenu()].concat(s1Screens().map(function (d) { return d[1](); }));
    templatesPage(h, 'Templates · Seller', 'Same structure as Admin with seller navigation, features and permissions. The order board is the tablet layout (touch density). Seller · Your seller account (S1, 1.7.0) is the landing page while a seller is not approved, in the limited shell. Shared · Members, Roles, No access, Not found, Account security and the Dialogs (1.8.0) sit in rows below; Seller · Setup (1.9.0: S1 with the sellers steps, S2 to S6) in the rows after them, then Seller · Store profile (1.10.0, S7).', list);
    addPanelTemplates(h, 'tpl-seller');
    addPanelTemplates(h, 'tpl-seller', null, panel183Defs, PANEL183_ROWS);
    addPanelTemplates(h, 'tpl-seller', null, setupDefs, SETUP_ROWS); // 1.9.0 Seller setup: S1 in each seller state, the steps S2 to S6, two state boards, phone frames
    addPanelTemplates(h, 'tpl-seller', null, sellerAdminDefs, SELLER_ADMIN_ROWS); // 1.10.0: Store profile (S7), its dialogs and phone frames
    return list;
  });
  const authScreensBuilt = await onPage(P['tpl-auth'], 'Auth templates', function (h) {
    const made = buildAuthFrames();
    rowsPage(h, 'Templates · Auth', AUTH_SUBTITLE, ['Seller', 'Admin', 'Phone'].map(function (r) { return made.filter(function (m) { return m.row === r; }).map(function (m) { return m.frame; }); }));
    return made.map(function (m) { return m.frame; });
  });
  await onPage(P['tpl-dark'], 'Dark preview', function (h) {
    const byName = {}; sellerScreens.concat(authScreensBuilt, P['tpl-seller'].host.children, P['tpl-admin'].host.children).forEach(function (s) { byName[s.name] = s; });
    const clones = [adminScreens[0], sellerScreens[1], sellerScreens[2]].concat(DARK_170.concat(DARK_190, DARK_1100).map(function (n) { return byName[n]; })).map(function (s) { const c = s.clone(); c.name = s.name + ' · Dark'; return c; });
    templatesPage(h, 'Templates · Dark preview', S.modes.color
      ? 'These frames use the Dark mode of the Color collection. Select any frame and switch the mode in the Appearance panel to compare.'
      : 'Starter plan: these copies are bound to the "Color · Dark" collection. Use the plugin buttons Dark theme / Light theme on a selection to switch any frame.', clones);
    clones.forEach(function (c) { applyTheme(c, 'dark'); });
  });
  await onPage(P.sandbox, 'Sandbox', function (h) {
    notePage(h, 'Sandbox', 'Work in progress. Nothing here is part of the library yet.', [
      'Start every proposal as a frame named "Proposal · <component> · <ticket>" and link the ticket in the description.',
      'Build only with variables, text styles and existing components. Detached instances are not reviewed.',
      'Show every state (default, hover, focus, disabled, error), both themes and, for seller features, the touch density.',
      'After review, move the component to its library page, bump the version and add a Changelog row.',
    ]);
  });
  await onPage(P.archive, 'Archive', function (h) {
    notePage(h, 'Archive', 'Retired components. Keep them until no screen uses them, then delete in the next MAJOR version.', [
      'Rename a retired component to "Deprecated / <Name>" and write "Use <Replacement> instead (since vX.Y)" in its description.',
      'Move it to this page; existing instances keep working, the asset panel stops suggesting it.',
    ]);
  });
  await onPage(P.changelog, 'Changelog', pageChangelog);
  await onPage(P.cover, 'Cover', pageCover);

  if (L.compact) arrangeSections(P);
  await figma.setCurrentPageAsync(P.cover.page);
  figma.viewport.scrollAndZoomIntoView(L.compact ? [P.cover.host] : P.cover.page.children);
  log('✓ Components: ' + S.counts.components + ' components and sets (incl. ' + Object.keys(ICONS).length + ' icons), ' + S.counts.variants + ' variants, ' + S.counts.instances + ' instances in docs and templates.');
  if (S.modes.color) log('✓ Light/Dark and Desktop/Touch are variable modes.');
  log('✓ Layout: ' + (L.compact ? '3 pages with sections (Starter).' : PAGES.length + ' pages.'));
  post({ type: 'done', report: S.report, counts: S.counts, modes: S.modes });
}

// ---------------------------------------------------------------- update library (add what a newer plugin release brings)
// Idempotent: every step first checks whether its result already exists and only adds what is missing.
// It never deletes, renames or rebuilds anything, so designs made with the library keep working.
const PHONE_TEMPLATES = { 'tpl-seller': { names: ['Seller · Home (phone)', 'Seller · Menu open (phone)'], make: function () { return [tplSellerPhoneHome(), tplSellerPhoneMenu()]; } },
  'tpl-admin': { names: ['Admin · Menu open (phone)'], make: function () { return [tplAdminPhoneMenu()]; } } };

// Rebuild S.ts, S.es, S.icons and S.sets from what is already in the file.
async function hydrateLibrary() {
  S.ts = {}; S.es = {}; S.icons = {}; S.sets = {};
  (await figma.getLocalTextStylesAsync()).forEach(function (st) { S.ts[st.name] = st; });
  (await figma.getLocalEffectStylesAsync()).forEach(function (st) { S.es[st.name] = st; });
  figma.root.children.forEach(function (page) {
    page.findAll(function (n) { return n.type === 'COMPONENT_SET' || n.type === 'COMPONENT'; }).forEach(function (n) {
      if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') return;
      if (n.name.indexOf('Icon/') === 0) { if (n.type === 'COMPONENT' && !S.icons[n.name.slice(5)]) S.icons[n.name.slice(5)] = n; return; }
      if (S.sets[n.name]) return;
      const defs = n.componentPropertyDefinitions; const keys = {}; const axes = [];
      Object.keys(defs).forEach(function (k) { if (defs[k].type === 'VARIANT') axes.push(k); else keys[k.split('#')[0]] = k; });
      S.sets[n.name] = n.type === 'COMPONENT_SET' ? { set: n, keys: keys, axes: axes } : { comp: n, keys: keys, axes: [] };
    });
  });
}
// T[key] = { page, host } for the pages (full layout) or sections (Starter layout) the build made.
function findHosts() {
  const T = {};
  figma.root.children.forEach(function (p) {
    if (p.getPluginData(PLUGIN_TAG) !== 'page') return;
    const key = p.getPluginData('key');
    const secs = p.children.filter(function (n) { return n.type === 'SECTION' && n.getPluginData('key'); });
    if (p.getPluginData('layout') === 'compact') secs.forEach(function (n) { T[n.getPluginData('key')] = { page: p, host: n }; });
    else T[key] = { page: p, host: secs.filter(function (n) { return n.getPluginData('key') === key; })[0] || p };
  });
  return T;
}
function rightEdge(host) { let r = 0; host.children.forEach(function (c) { r = Math.max(r, c.x + c.width); }); return r; }
// A Starter section is a fixed-size box: grow it so new content stays inside.
function fitSection(host) {
  if (host.type !== 'SECTION') return;
  let w = host.width, h = host.height;
  host.children.forEach(function (c) { w = Math.max(w, c.x + c.width + 80); h = Math.max(h, c.y + c.height + 96); });
  host.resizeWithoutConstraints(w, h);
}
function appendTableRow(tbl, cells, widths) {
  const prev = tbl.children[tbl.children.length - 1];
  const row = tableRow(cells, widths, true); add(tbl, row);
  if (prev && prev.name === 'Row') { prev.strokes = [paint('border/row')]; prev.strokeAlign = 'INSIDE'; prev.strokeTopWeight = 0; prev.strokeLeftWeight = 0; prev.strokeRightWeight = 0; prev.strokeBottomWeight = 1; }
  return row;
}
function findTable(host, headers) {
  return host.findAll(function (n) { return n.type === 'FRAME' && n.name === 'Table' && n.children.length && n.children[0].name === 'Header' && n.children[0].children.map(function (c) { return c.name; }).join('|') === headers; })[0] || null;
}
function pageOf(node) { let p = node; while (p && p.type !== 'PAGE') p = p.parent; return { page: p, host: p }; }
function bottomEdge(host) { let b = 0; host.children.forEach(function (c) { b = Math.max(b, c.y + c.height); }); return b; }
// 1.8.1: Update library never moves a frame (the owner may have placed it). After a repair made a screen taller it only reports top-level nodes whose bounds now overlap.
function reportOverlapsIn(parent, label) {
  const kids = parent.children.filter(function (n) { return n.visible !== false; });
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const a = kids[i], b = kids[j];
    if (a.x + a.width > b.x + 0.5 && b.x + b.width > a.x + 0.5 && a.y + a.height > b.y + 0.5 && b.y + b.height > a.y + 0.5) log('ℹ overlap: ' + a.name + ' and ' + b.name + ' on ' + label + '; move one by hand');
  }
}
// Pages (and the sections on them) that this run changed; nothing is moved, whatever is found.
function reportOverlaps() {
  UPDATE_TOUCHED.forEach(function (pg) {
    reportOverlapsIn(pg, pg.name);
    pg.children.forEach(function (n) { if (n.type === 'SECTION') reportOverlapsIn(n, pg.name + ' › ' + n.name); });
  });
}
// The library page's root frame (made by pageShell), or a new one to the right of what is there.
function docRoot(host, title, subtitle) {
  let root = host.children.filter(function (n) { return n.type === 'FRAME' && n.name === title; })[0];
  if (!root) { const y = host.children.length ? Math.min.apply(null, host.children.map(function (c) { return c.y; })) : 0; const x = rightEdge(host) + 160; root = pageShell(host, title, subtitle); root.x = x; root.y = y; tag(root); }
  return root;
}
// Templates · Auth (1.7.0) in a file built before it: a section below the other template sections (Starter layout)
// or a new page after Templates · Seller.
async function ensureAuthHost(T) {
  if (T['tpl-auth']) return T['tpl-auth'];
  const ref = T['tpl-seller'];
  if (ref.host.type === 'SECTION') {
    await figma.setCurrentPageAsync(ref.page);
    let bottom = 0; ref.page.children.forEach(function (n) { bottom = Math.max(bottom, n.y + n.height); });
    const sec = makeSection(ref.page, 'tpl-auth'); sec.x = ref.host.x; sec.y = bottom + 240; sec.resizeWithoutConstraints(480, 320);
    T['tpl-auth'] = { page: ref.page, host: sec };
    return T['tpl-auth'];
  }
  let p = null; try { p = figma.createPage(); } catch (e) { return null; }
  p.name = TITLE['tpl-auth']; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', 'tpl-auth'); p.setPluginData('layout', 'full');
  figma.root.insertChild(figma.root.children.indexOf(ref.page) + 1, p);
  T['tpl-auth'] = { page: p, host: p };
  return T['tpl-auth'];
}
function semverLess(a, b) { const x = String(a || '0').split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; }

// In-place fix for two 1.7.0 sets that were wider than the 1440 px page (real-Figma Audit: layers sticking out of their
// parent). Input (Type x State) is laid out with Type in columns; AuthShowcase puts one variant per row; their documentation
// blocks are re-fitted. Only positions and the block around each set change: no variant, layer or instance is renamed,
// rebuilt or deleted. Sets that are not the plugin's are left alone. Returns the report lines; a second run returns none.
function fixLayout170(own) {
  const done = [];
  [['Input', INPUT_AXES, INPUT_OPTS], ['AuthShowcase', { Workspace: ['Admin', 'Seller'] }, { width: SHOWCASE_SET_W, gapX: 40 }]].forEach(function (f) {
    const rec = S.sets[f[0]]; if (!rec || !rec.set || !own(f[0])) return;
    if (rec.set.width > DOC_CONTENT_W) { gridVariants(rec.set, f[1], f[2]); done.push(f[0] + ' variants laid out to fit the page (' + Math.round(rec.set.width) + ' px wide)'); }
    if (fitBlock(rec.set)) done.push(f[0] + ' documentation block re-fitted to the set');
  });
  return done;
}
// Starter layout (3 pages of canvas sections): Update library grows a section to fit what it adds (fitSection) but did not
// move the sections after it, so they ended up on top of each other (owner's file after 1.7.0 and 1.8.0, page 3). On each
// compact page, a section that overlaps one before it (in the page's direction: down on the templates page, right on the
// others) moves past it with the usual 240 px gap. Sections that do not overlap stay where they are, so a layout the owner
// arranged by hand is kept. Returns the report lines.
function restackSections() {
  const done = [];
  figma.root.children.forEach(function (page) {
    if (page.getPluginData(PLUGIN_TAG) !== 'page' || page.getPluginData('layout') !== 'compact') return;
    const def = COMPACT.filter(function (d) { return d[0] === page.getPluginData('key'); })[0]; const down = !def || def[2] === 'V';
    const secs = page.children.filter(function (n) { return n.type === 'SECTION' && n.getPluginData(PLUGIN_TAG) === 'section'; })
      .sort(function (a, b) { return down ? (a.y - b.y) || (a.x - b.x) : (a.x - b.x) || (a.y - b.y); });
    const hits = function (a, b) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; };
    secs.forEach(function (sec, i) {
      let moved = false;
      for (let guard = 0; guard < secs.length; guard++) {
        const over = secs.slice(0, i).filter(function (o) { return hits(sec, o); });
        if (!over.length) break;
        if (down) sec.y = Math.max.apply(null, over.map(function (o) { return o.y + o.height; })) + 240;
        else sec.x = Math.max.apply(null, over.map(function (o) { return o.x + o.width; })) + 240;
        moved = true;
      }
      if (moved) done.push('section ' + sec.name + ' moved ' + (down ? 'down' : 'right') + ' so it no longer overlaps the section before it');
    });
  });
  return done;
}
async function updateLibrary() {
  STEP = 0; STEPS = 8; S.report = []; UPDATE_TOUCHED.length = 0;
  await figma.loadAllPagesAsync();
  const state = await fileIsEmpty();
  if (state.empty) { post({ type: 'error', message: 'This file is empty. Update library only adds to an existing MondaPac library; use Build library in a new file.' }); return; }
  if (!state.hasLibrary) { post({ type: 'error', message: 'This file has no MondaPac library. Use Build library in a new, empty design file.' }); return; }
  await loadState();
  await hydrateLibrary();
  const T = findHosts();
  // Release 1.8.0 builds on the 1.7.0 library (Field, Menu, MenuItem, Button Link and Loading, Input Password and Code, ReasonQuote, icon lock).
  // Refuse a file that does not have it, before anything is touched.
  const fileVersion = figma.root.getPluginData('version') || '1.0.0';
  const has170 = function (name, re) { const r = S.sets[name]; return !!(r && (r.comp || (r.set && (!re || r.set.children.some(function (c) { return re.test(c.name); }))))); };
  const miss170 = [];
  if (!has170('Field')) miss170.push('Field'); if (!has170('Menu')) miss170.push('Menu'); if (!has170('MenuItem', /State=Selected/)) miss170.push('MenuItem with State=Selected');
  if (!has170('ReasonQuote')) miss170.push('ReasonQuote'); if (!has170('Button', /Variant=Link/) || !has170('Button', /State=Loading/)) miss170.push('Button Link and Loading');
  if (!has170('Input', /Type=Password/) || !has170('Input', /Type=Code/)) miss170.push('Input Password and Code'); if (!S.icons.lock) miss170.push('icon lock');
  if (semverLess(fileVersion, '1.7.0') || miss170.length) {
    post({ type: 'error', message: semverLess(fileVersion, '1.7.0')
      ? 'This file is at library version ' + fileVersion + ', below 1.7.0. Release 1.8.0 builds on release 1.7.0 (Field, Menu, MenuItem, Button Link and Loading, Input Password and Code, ReasonQuote, icon lock): run 1.7.0 first (Update library from the 1.7.0 plugin), then run Update library again with this plugin. Nothing was changed.'
      : 'Release 1.8.0 needs release 1.7.0 items that this file does not have: ' + miss170.join(', ') + '. Run 1.7.0 first (Update library from the 1.7.0 plugin), then run Update library again with this plugin. Nothing was changed.' }); return;
  }
  const need = ['nav', 'forms', 'review', 'tpl-seller', 'tpl-admin', 'tpl-dark', 'changelog', 'spacing', 'cover', 'icons'].filter(function (k) { return !T[k]; });
  const base = ['CountBadge', 'NavGroupLabel', 'NavItem', 'IconButton', 'IdentityTile', 'QueueCard', 'Sidebar', 'Topbar', 'Button', 'Input', 'Checkbox', 'Badge', 'InfoBanner', 'ProductThumb', 'ChecklistItem'].filter(function (k) { return !S.sets[k]; });
  if (need.length || base.length || !S.ts['Body/Default'] || !S.es['Focus/Ring']) {
    post({ type: 'error', message: 'This library is incomplete, so it cannot be updated safely. Missing: ' + need.concat(base).join(', ') + '. Restore it from version history or rebuild it in a new file.' }); return;
  }
  await loadFonts();
  const added = [];

  // 1 · tokens (1.7.0 adds primitives first: new colour tokens alias them)
  const missingPrims = S.primColl ? SPEC.primitives.filter(function (p) { return !S.prim[p.name]; }) : [];
  missingPrims.forEach(function (p) { addPrimitive(p); added.push('primitive ' + p.name); });
  const missingColors = SPEC.color.filter(function (c) { return !S.color[c.name]; });
  missingColors.forEach(function (c) { addColorVariable(c); added.push('variable ' + c.name + (S.colorModes.darkCollection ? ' (Color and Color · Dark)' : ' (Light and Dark modes)')); });
  const missingVars = SPEC.dimension.filter(function (d) { return !S.dim[d.name]; });
  missingVars.forEach(function (d) { addDimensionVariable(d); added.push('variable ' + d.name + (S.dimModes.touchCollection ? ' (Dimension and Dimension · Touch)' : ' (Desktop and Touch modes)')); });

  // 1b · icons (1.6.0: menu), added to the Icons page
  const missingIcons = Object.keys(ICONS).filter(function (n) { return !S.icons[n]; });
  if (missingIcons.length) {
    await onPage(T.icons, 'Icons', function (host) {
      const wrap = host.findAll(function (n) { return n.type === 'FRAME' && n.name === 'Icons' && n.layoutWrap === 'WRAP'; })[0];
      missingIcons.forEach(function (n) {
        const cell = iconCell(n);
        if (wrap) add(wrap, cell); else { cell.x = rightEdge(host) + 160; cell.y = 0; host.appendChild(cell); }
      });
      fitSection(host);
    });
    missingIcons.forEach(function (n) { added.push('icon ' + n); });
  }

  // 2 · components, documented on the Navigation & shell page
  const have = { NavDrawer: !!S.sets.NavDrawer, BottomTabBar: !!S.sets.BottomTabBar, PhoneTopbar: !!S.sets.PhoneTopbar };
  if (!have.NavDrawer || !have.BottomTabBar || !have.PhoneTopbar) {
    await onPage(T.nav, 'Navigation components', function (host) {
      let root = host.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Navigation & shell'; })[0];
      if (!root) { const y = host.children.length ? Math.min.apply(null, host.children.map(function (c) { return c.y; })) : 0; const x = rightEdge(host) + 160; root = pageShell(host, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.'); root.x = x; root.y = y; tag(root); }
      buildMobileNav(root, have);
      fitSection(host);
    });
    if (!have.PhoneTopbar) added.push('component PhoneTopbar');
    if (!have.NavDrawer) added.push('component NavDrawer');
    if (!have.BottomTabBar) added.push('component BottomTabBar');
  }

  // 2b · fixes to components an earlier 1.5.0 update added (real-Figma Audit, 2026-10-07):
  // the seller drawer's item list was 3 px taller than the drawer, so its rows lose the 2 px gap.
  if (have.NavDrawer && S.sets.NavDrawer.set) {
    const lists = [];
    S.sets.NavDrawer.set.children.forEach(function (v) { const l = v.findOne(function (n) { return n.type === 'FRAME' && n.name === 'items'; }); if (l && l.itemSpacing !== 0) lists.push(l); });
    if (lists.length) {
      await onPage(T.nav, 'NavDrawer item spacing', function () { lists.forEach(function (l) { l.setBoundVariable('itemSpacing', null); l.itemSpacing = 0; }); });
      added.push('fix NavDrawer item spacing (' + lists.length + ' variants)');
    }
  }

  // 2b-2 · the NavDrawer description of a 1.5.0 file still names the old scrim (text/primary at 50%); use the 1.6.0 wording.
  const OLD_SCRIM_NOTE = 'scrim (text/primary at 50%; the scrim belongs', NEW_SCRIM_NOTE = 'scrim (bg/scrim; the scrim belongs';
  if (have.NavDrawer && S.sets.NavDrawer.set && S.sets.NavDrawer.set.description.indexOf(OLD_SCRIM_NOTE) >= 0) {
    const nd = S.sets.NavDrawer.set;
    await onPage(T.nav, 'NavDrawer scrim note', function () { nd.description = nd.description.split(OLD_SCRIM_NOTE).join(NEW_SCRIM_NOTE); });
    added.push('update NavDrawer scrim note');
  }

  // 2c · fixes to the phone templates an earlier 1.5.0 update added (release 1.6.0): the drawer scrim takes bg/scrim
  // at 100% (it was text/primary at 50%) and the loose "Topbar · phone" frame becomes a PhoneTopbar instance.
  // The old frame is the only thing this release deletes, and only inside a plugin-made phone template.
  // The old frame is only removed when it has the 1.5.0 shape, and only if PhoneTopbar is the plugin's own set.
  function isPluginPhoneTopbar(n) {
    return n.type === 'FRAME' && n.layoutMode === 'HORIZONTAL' && Math.round(n.height) === 56 && ['menu-button', 'panel-name', 'notifications', 'account-button'].every(function (nm) { return n.children.some(function (c) { return c.name === nm; }); });
  }
  const ptbOk = !!(S.sets.PhoneTopbar && S.sets.PhoneTopbar.set && S.sets.PhoneTopbar.set.getPluginData(PLUGIN_TAG) === '1'); let clash = false;
  const phoneTplKeys = Object.keys(PHONE_TEMPLATES); const scrimFix = []; const topbarFix = [];
  phoneTplKeys.forEach(function (key) {
    T[key].host.children.forEach(function (scr) {
      if (scr.type !== 'FRAME' || PHONE_TEMPLATES[key].names.indexOf(scr.name) < 0 || scr.getPluginData(PLUGIN_TAG) !== '1') return;
      const scrim = scr.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'scrim'; })[0];
      const bound = S.color['bg/scrim'] ? S.color['bg/scrim'].id : null;
      if (scrim && bound && !(scrim.fills.length === 1 && scrim.fills[0].boundVariables && scrim.fills[0].boundVariables.color && scrim.fills[0].boundVariables.color.id === bound && (scrim.fills[0].opacity === undefined || scrim.fills[0].opacity === 1))) scrimFix.push({ key: key, scrim: scrim });
      const old = scr.children.filter(function (n) { return n.name === 'Topbar · phone'; })[0];
      if (old && !isPluginPhoneTopbar(old)) log('ℹ skipped Topbar · phone in ' + scr.name + ': not the plugin\'s frame');
      else if (old && !ptbOk) { if (!clash) log('ℹ skipped phone topbar swap: a PhoneTopbar component set that is not the plugin\'s already exists in this file'); clash = true; }
      else if (old) topbarFix.push({ key: key, scr: scr, old: old });
    });
  });
  for (let i = 0; i < phoneTplKeys.length; i++) {
    const key = phoneTplKeys[i];
    const sf = scrimFix.filter(function (f) { return f.key === key; }); const tf = topbarFix.filter(function (f) { return f.key === key; });
    if (!sf.length && !tf.length) continue;
    await onPage(T[key], 'Phone template fixes', function () {
      sf.forEach(function (f) { f.scrim.fills = [paint('bg/scrim')]; });
      tf.forEach(function (f) {
        const at = f.scr.children.indexOf(f.old);
        const ptb = phoneTopbar(f.scr.name.indexOf('Admin') === 0 ? 'Admin' : 'Seller');
        add(f.scr, ptb); f.scr.insertChild(at, ptb);
        f.old.remove();
      });
    });
  }
  if (scrimFix.length) added.push('bind drawer scrim to bg/scrim (' + scrimFix.length + ' templates)');
  if (topbarFix.length) added.push('swap phone topbar for PhoneTopbar (' + topbarFix.length + ' templates)');

  // 2d · release 1.7.0 "Auth": variants and properties added to existing sets, then the new components.
  // Only sets the plugin made are changed (PLUGIN_TAG); a set of the same name made by someone else is skipped and reported.
  const own = function (name) { const r = S.sets[name]; const n = r && (r.set || r.comp); return !!(n && n.getPluginData(PLUGIN_TAG) === '1'); };
  const skipped = {};
  const skip = function (name, why) { skipped[name] = 1; log('ℹ skipped ' + why); };
  const missingCombos = function (rec, list) { const have = {}; rec.set.children.forEach(function (c) { have[variantName(sortedProps(c.variantProperties, rec.axes))] = 1; }); return list.filter(function (p) { return !have[variantName(sortedProps(p, rec.axes))]; }); };
  const OLD_DESC = { Button: 'Actions. Primary: one per area. Secondary: supporting actions. Destructive: irreversible actions, label ends with … and opens a confirmation. Ghost: low-emphasis actions like Clear.', Input: 'Text and search input. Border uses border/input (3:1).', ChecklistItem: 'One verification check. Automatic checks show when they ran; manual checks offer Confirm or Flag a problem.', Topbar: 'Breadcrumb, command search (Ctrl K), market context, notifications and the user.' };
  const NEW_DESC = { Button: BUTTON_OPTS.desc, Input: INPUT_DESC_170, ChecklistItem: CHECKLIST_DESC_170, Topbar: TOPBAR_DESC }; // the 1.9.0 step adds its own sentences once it adds the properties
  const refreshDesc = function (name) { const n = S.sets[name].set; if (n.description === OLD_DESC[name]) { n.description = NEW_DESC[name]; added.push('update ' + name + ' description'); } };
  let inputRenamed = 0;
  if (!own('Button')) skip('Button', 'Button variants Link and Loading: the Button set is not the plugin\'s');
  else if (missingCombos(S.sets.Button, combos(BUTTON_AXES)).length || S.sets.Button.set.description === OLD_DESC.Button) {
    await onPage(pageOf(S.sets.Button.set), 'Button variants', function () {
      const made = addVariants(S.sets.Button, combos(BUTTON_AXES), buttonVariant, BUTTON_OPTS, 'State');
      if (made.length) added.push('Button variants (' + made.length + '): Variant=Link and State=Loading');
      refreshDesc('Button');
    });
  }
  if (!own('Input')) skip('Input', 'Input variants Password and Code: the Input set is not the plugin\'s');
  else {
    const rec = S.sets.Input;
    const plain = rec.set.children.filter(function (c) { return c.variantProperties.Type === undefined; });
    const later = rec.axes.indexOf('Type') >= 0 ? missingCombos(rec, combos(INPUT_AXES)) : ['all'];
    if (plain.length || later.length || rec.set.description === OLD_DESC.Input) {
      await onPage(pageOf(rec.set), 'Input variants', function () {
        // The Type axis is added by naming the existing variants Type=Text; their layers and instances stay as they are.
        plain.forEach(function (c) { c.name = 'Type=Text, ' + c.name; }); inputRenamed = plain.length;
        if (rec.axes.indexOf('Type') < 0) rec.axes = ['Type'].concat(rec.axes);
        if (plain.length) added.push('Input variant property Type (' + plain.length + ' existing variants named Type=Text)');
        const made = addVariants(rec, combos(INPUT_AXES), inputVariant, INPUT_OPTS, 'State');
        if (made.length) added.push('Input variants (' + made.length + '): Type=Password and Type=Code');
        refreshDesc('Input');
      });
    }
  }
  if (!own('ChecklistItem')) skip('ChecklistItem', 'ChecklistItem variants Waiting and Needs attention: the ChecklistItem set is not the plugin\'s');
  else {
    const rec = S.sets.ChecklistItem;
    if (!rec.keys['Show actions'] || !rec.keys.Action || missingCombos(rec, combos(CHECKLIST_AXES)).length || rec.set.description === OLD_DESC.ChecklistItem) {
      await onPage(pageOf(rec.set), 'ChecklistItem variants', function () {
        if (!rec.keys['Show actions']) { rec.keys['Show actions'] = rec.set.addComponentProperty('Show actions', 'BOOLEAN', true); rec.set.children.forEach(function (v) { wireVariant(v, rec.keys, { bool: CHECKLIST_OPTS.bool }); }); added.push('ChecklistItem property Show actions'); }
        if (!rec.keys.Action) { rec.keys.Action = rec.set.addComponentProperty('Action', 'TEXT', 'Update your details'); added.push('ChecklistItem property Action'); }
        const made = addVariants(rec, combos(CHECKLIST_AXES), checklistVariant, CHECKLIST_OPTS, 'State');
        if (made.length) added.push('ChecklistItem variants (' + made.length + '): Waiting and Needs attention');
        refreshDesc('ChecklistItem');
      });
    }
  }
  if (!own('Topbar')) skip('Topbar', 'Topbar properties Show search and Show notifications: the Topbar set is not the plugin\'s');
  else {
    const rec = S.sets.Topbar; const miss = TOPBAR_BOOLS.filter(function (b) { return !rec.keys[b.prop]; });
    if (miss.length || rec.set.description === OLD_DESC.Topbar) {
      await onPage(pageOf(rec.set), 'Topbar properties', function () {
        miss.forEach(function (b) { rec.keys[b.prop] = rec.set.addComponentProperty(b.prop, 'BOOLEAN', b.def); rec.set.children.forEach(function (v) { wireVariant(v, rec.keys, { bool: [b] }); }); added.push('Topbar property ' + b.prop); });
        refreshDesc('Topbar');
      });
    }
  }
  // 2d2 · layout fix for two 1.7.0 sets that were wider than the 1440 px page (fixLayout170, below).
  fixLayout170(own).forEach(function (a) { added.push(a); });
  // New components. A component of the same name that is not the plugin's blocks it (and what depends on it).
  ['BrandMark', 'MenuItem', 'Menu', 'ReasonQuote', 'Field', 'AuthShowcase'].forEach(function (n) { if (S.sets[n] && !own(n)) skip(n, 'component ' + n + ': a component named ' + n + ' that is not the plugin\'s already exists in this file'); });
  if (skipped.Input && !S.sets.Field) skip('Field', 'component Field: it needs the plugin\'s Input with Type=Text');
  if (skipped.MenuItem && !S.sets.Menu) skip('Menu', 'component Menu: it needs the plugin\'s MenuItem');
  const navNew = ['BrandMark', 'MenuItem', 'Menu', 'AuthShowcase'].filter(function (n) { return !S.sets[n] && !skipped[n]; });
  if (navNew.length) {
    await onPage(T.nav, 'Auth components', function (host) {
      const root = docRoot(host, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.');
      if (navNew.indexOf('BrandMark') >= 0) brandMarkBlock(root);
      if (navNew.indexOf('Menu') >= 0 || navNew.indexOf('MenuItem') >= 0) menuBlock(root, { MenuItem: S.sets.MenuItem ? S.sets.MenuItem.set : null });
      if (navNew.indexOf('AuthShowcase') >= 0) showcaseBlock(root);
      fitSection(host);
    });
    navNew.forEach(function (n) { added.push('component ' + n); });
  }
  if (!S.sets.ReasonQuote && !skipped.ReasonQuote) {
    await onPage(T.review, 'ReasonQuote', function (host) { reasonQuoteBlock(docRoot(host, 'Review & detail', 'Building blocks of the review workspace: queue summary cards, extracted document fields, checks and the activity timeline.')); fitSection(host); });
    added.push('component ReasonQuote');
  }
  if (!S.sets.Field && !skipped.Field) {
    await onPage(T.forms, 'Field', function (host) { fieldBlock(docRoot(host, 'Forms & selection', 'Inputs, checkboxes, switches, segmented controls, tabs and filter chips.')); fitSection(host); });
    added.push('component Field');
  }

  // 2e · release 1.8.0 "Panel": Select, Textarea, CheckboxRow, Toast, DialogBody + Dialog and EmptyState are new sets; TableCell gets State=Loading
  // (the only edit to an existing set, below); Field's Control slot lists Input, Select and Textarea as preferred values.
  PANEL_SETS.forEach(function (n) { if (S.sets[n] && !own(n)) skip(n, 'component ' + n + ': a component named ' + n + ' that is not the plugin\'s already exists in this file'); });
  const PANEL_DEPS = { CheckboxRow: ['Checkbox', 'Badge'], Toast: ['IconButton'], Dialog: ['Button', 'IconButton', 'DialogBody'], EmptyState: ['Button'] };
  Object.keys(PANEL_DEPS).forEach(function (n) {
    if (S.sets[n] || skipped[n]) return;
    const bad = PANEL_DEPS[n].filter(function (d) { return skipped[d] || (S.sets[d] && !own(d)); });
    if (bad.length) skip(n, 'component ' + n + ': it needs the plugin\'s ' + bad.join(', '));
  });
  const panelNew = function (list) { return list.filter(function (n) { return !S.sets[n] && !skipped[n]; }); };
  const formsNew = panelNew(['Select', 'Textarea', 'CheckboxRow']);
  if (formsNew.length) {
    await onPage(T.forms, 'Panel form components', function (host) {
      const root = docRoot(host, 'Forms & selection', PANEL_SUBTITLE['Forms & selection']);
      if (formsNew.indexOf('Select') >= 0) selectBlock(root);
      if (formsNew.indexOf('Textarea') >= 0) textareaBlock(root);
      if (formsNew.indexOf('CheckboxRow') >= 0) checkboxRowBlock(root);
      fitSection(host);
    });
    formsNew.forEach(function (n) { added.push('component ' + n); });
  }
  const statusNew = panelNew(['Toast', 'DialogBody', 'Dialog']);
  if (statusNew.length) {
    await onPage(T.status, 'Panel feedback components', function (host) {
      const root = docRoot(host, 'Status & feedback', PANEL_SUBTITLE['Status & feedback']);
      if (statusNew.indexOf('Toast') >= 0) toastBlock(root);
      if (statusNew.indexOf('Dialog') >= 0 || statusNew.indexOf('DialogBody') >= 0) dialogBlock(root);
      fitSection(host);
    });
    statusNew.forEach(function (n) { added.push('component ' + n); });
  }
  const tablesNew = panelNew(['EmptyState']);
  if (tablesNew.length) {
    await onPage(T.tables, 'EmptyState', function (host) { emptyStateBlock(docRoot(host, 'Tables & collections', PANEL_SUBTITLE['Tables & collections'])); fitSection(host); });
    added.push('component EmptyState');
  }
  // In place, the only edit to an existing set: TableCell gets the State=Loading variants (cloned from Type=…, State=Default; nothing is renamed or removed).
  let tcMade = 0; let prefChanged = false;
  if (!own('TableCell')) skip('TableCell', 'TableCell State=Loading: the TableCell set is not the plugin\'s');
  else {
    const rec = S.sets.TableCell;
    const todo = TABLECELL_TYPES_LOADING.some(function (t) { return !rec.set.children.some(function (c) { return c.name === 'Type=' + t + ', State=Loading'; }); });
    if (todo || rec.set.description === TABLECELL_DESC_170) {
      await onPage(pageOf(rec.set), 'TableCell Loading', function () {
        const made = todo ? addTableCellLoading() : [];
        tcMade = made.length;
        if (made.length) added.push('variants added to TableCell (' + made.length + '): State=Loading');
        if (rec.set.description === TABLECELL_DESC_170) { rec.set.description = TABLECELL_DESC; added.push('update TableCell description'); }
        fitSection(T.tables.host);
      });
    }
  }
  const tcLoading = !!(S.sets.TableCell && S.sets.TableCell.set && TABLECELL_TYPES_LOADING.every(function (t) { return S.sets.TableCell.set.children.some(function (c) { return c.name === 'Type=' + t + ', State=Loading'; }); }));
  if (S.sets.Field && S.sets.Field.comp && own('Field') && own('Input') && own('Select') && own('Textarea')) {
    const f = S.sets.Field.comp;
    await onPage(pageOf(f), 'Field Control', function () {
      if (f.description === FIELD_DESC_170) { f.description = FIELD_DESC_180; added.push('update Field description'); }
      prefChanged = fieldPreferred();
      if (prefChanged) added.push('Field Control: preferred values Input, Select, Textarea');
    });
  }

  // 2f · release 1.9.0 "Seller setup": FieldStatus, FormActionBar and DataRow are new sets; Field, Input and ChecklistItem get new properties,
  // their nodes added in place to the plugin's own component (hidden, like their boolean's default), so no existing instance changes.
  // A component whose structure was changed by hand is reported and left; so is a set of the same name that is not the plugin's.
  ['FieldStatus', 'FormActionBar', 'DataRow'].forEach(function (n) { if (S.sets[n] && !own(n)) skip(n, 'component ' + n + ': a component named ' + n + ' that is not the plugin\'s already exists in this file'); });
  const SETUP_DEPS = { FormActionBar: ['Button'], DataRow: ['Badge'] };
  Object.keys(SETUP_DEPS).forEach(function (n) {
    if (S.sets[n] || skipped[n]) return;
    const bad = SETUP_DEPS[n].filter(function (d) { return !own(d); });
    if (bad.length) skip(n, 'component ' + n + ': it needs the plugin\'s ' + bad.join(', '));
  });
  const setupNew = function (list) { return list.filter(function (n) { return !S.sets[n] && !skipped[n]; }); };
  const formsNew190 = setupNew(['FieldStatus', 'FormActionBar']);
  if (formsNew190.length) {
    await onPage(T.forms, 'Seller setup form components', function (host) {
      const root = docRoot(host, 'Forms & selection', PANEL_SUBTITLE['Forms & selection']);
      if (formsNew190.indexOf('FieldStatus') >= 0) fieldStatusBlock(root);
      if (formsNew190.indexOf('FormActionBar') >= 0) formActionBarBlock(root);
      fitSection(host);
    });
    formsNew190.forEach(function (n) { added.push('component ' + n); });
  }
  if (setupNew(['DataRow']).length) {
    await onPage(T.review, 'DataRow', function (host) { dataRowBlock(docRoot(host, 'Review & detail', 'Building blocks of the review workspace: queue summary cards, extracted document fields, checks and the activity timeline.')); fitSection(host); });
    added.push('component DataRow');
  }
  for (const step of propertySteps190(own)) {
    await onPage(pageOf(step.node), step.label, function () {
      step.run().forEach(function (a) { added.push(a); });
      let sec = step.node; while (sec && sec.type !== 'SECTION' && sec.type !== 'PAGE') sec = sec.parent;
      if (sec && sec.type === 'SECTION') fitSection(sec); // on Starter, a Usage list that grew can push the doc frame past its section
    });
  }

  // 2g · release 1.10.0 "Seller admin": SettingRow is a new set (its Control slot prefers Switch and SegmentedControl); CheckboxRow gets
  // State=Saving and Show undo in place (propertySteps1100: the undo link is added hidden, so no existing instance changes).
  if (S.sets.SettingRow && !own('SettingRow')) skip('SettingRow', 'component SettingRow: a component named SettingRow that is not the plugin\'s already exists in this file');
  else if (!S.sets.SettingRow) {
    const bad = ['Switch', 'SegmentedControl'].filter(function (d) { return !own(d); });
    if (bad.length) skip('SettingRow', 'component SettingRow: it needs the plugin\'s ' + bad.join(', '));
    else {
      await onPage(T.forms, 'SettingRow', function (host) { settingRowBlock(docRoot(host, 'Forms & selection', PANEL_SUBTITLE['Forms & selection'])); fitSection(host); });
      added.push('component SettingRow');
    }
  }
  for (const step of propertySteps1100(own)) {
    await onPage(pageOf(step.node), step.label, function () {
      step.run().forEach(function (a) { added.push(a); });
      let sec = step.node; while (sec && sec.type !== 'SECTION' && sec.type !== 'PAGE') sec = sec.parent;
      if (sec && sec.type === 'SECTION') fitSection(sec);
    });
  }

  // 3b · 1.7.0 templates: Auth (its own page or section), S1 on Templates · Seller, and their dark previews.
  // A template is built only when every component it places is the plugin's (made earlier or in this run).
  const blockedBy = function (names) { return names.filter(function (n) { return skipped[n] || !own(n); }); };
  const authBlock = blockedBy(['Button', 'Input', 'BrandMark', 'Field', 'AuthShowcase', 'ReasonQuote', 'Badge', 'InfoBanner', 'Checkbox']);
  const s1Block = blockedBy(['Button', 'ChecklistItem', 'Topbar', 'ReasonQuote', 'MenuItem', 'Menu', 'Sidebar', 'PhoneTopbar', 'Badge', 'InfoBanner']);
  if (authBlock.length) log('ℹ skipped Auth templates: they need the plugin\'s ' + authBlock.join(', '));
  else {
    const present = T['tpl-auth'] ? T['tpl-auth'].host.children.map(function (c) { return c.name; }) : [];
    const missing = authFrameNames().filter(function (n) { return present.indexOf(n) < 0; });
    const hostT = missing.length ? await ensureAuthHost(T) : T['tpl-auth'];
    if (missing.length && !hostT) log('ℹ skipped Auth templates: this file has no free page for Templates · Auth');
    else if (missing.length) {
      if (!present.length) added.push((hostT.host.type === 'SECTION' ? 'section ' : 'page ') + TITLE['tpl-auth']);
      await onPage(hostT, 'Auth templates', function (host) {
        const made = buildAuthFrames(missing);
        const rows = ['Seller', 'Admin', 'Phone'].map(function (r) { return made.filter(function (m) { return m.row === r; }).map(function (m) { return m.frame; }); });
        if (!host.children.length) rowsPage(host, 'Templates · Auth', AUTH_SUBTITLE, rows); else placeRows(host, rows, bottomEdge(host) + 240);
        fitSection(host);
      });
      added.push('templates Auth (' + missing.length + ' frames)');
    }
  }
  if (s1Block.length) log('ℹ skipped Seller · Your seller account templates: they need the plugin\'s ' + s1Block.join(', '));
  else {
    const present = T['tpl-seller'].host.children.map(function (c) { return c.name; });
    const missing = s1Screens().filter(function (d) { return present.indexOf(d[0]) < 0; });
    if (missing.length) {
      await onPage(T['tpl-seller'], 'Seller account templates', function (host) { placeRows(host, [missing.map(function (d) { return d[1](); })], bottomEdge(host) + 240); fitSection(host); });
      missing.forEach(function (d) { added.push('template ' + d[0]); });
    }
  }
  const darkHost = T['tpl-dark'].host; const darkPresent = darkHost.children.map(function (c) { return c.name; });
  const darkSources = DARK_170.filter(function (n) { return darkPresent.indexOf(n + ' · Dark') < 0; }).map(function (n) {
    const where = [T['tpl-auth'], T['tpl-seller']].filter(Boolean);
    for (let i = 0; i < where.length; i++) { const f = where[i].host.children.filter(function (c) { return c.type === 'FRAME' && c.name === n && c.getPluginData(PLUGIN_TAG) === '1'; })[0]; if (f) return f; }
    return null;
  }).filter(Boolean);
  if (darkSources.length) {
    await onPage(T['tpl-dark'], 'Dark preview', function (host) {
      let x = rightEdge(host) + 160; const ref = host.children.filter(function (n) { return n.type === 'FRAME' && n.height > 400; })[0]; const y = ref ? ref.y : 240;
      darkSources.forEach(function (src) { const c = src.clone(); c.name = src.name + ' · Dark'; host.appendChild(c); c.x = x; c.y = y; x += c.width + 160; applyTheme(c, 'dark'); added.push('dark preview ' + c.name); });
      fitSection(host);
    });
  }

  // 3c · 1.8.0 templates: Shared · Members, Roles, No access, Not found, Account security and the Dialogs, on Templates · Admin and Templates · Seller.
  // Built only when every set they place is the plugin's, TableCell has State=Loading, and only the frames the file does not have yet.
  const panelBlock = blockedBy(PANEL_TEMPLATE_NEEDS); if (!tcLoading) panelBlock.push('TableCell State=Loading');
  if (panelBlock.length) log('ℹ skipped Panel templates: they need the plugin\'s ' + panelBlock.join(', '));
  else {
    const keys = ['tpl-admin', 'tpl-seller'];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]; const present = T[key].host.children.map(function (c) { return c.name; });
      const missing = panelNames(key).filter(function (n) { return present.indexOf(n) < 0; });
      if (!missing.length) continue;
      let made = null;
      await onPage(T[key], key === 'tpl-admin' ? 'Admin panel templates' : 'Seller panel templates', function (host) { made = addPanelTemplates(host, key, missing); fitSection(host); });
      added.push('templates Panel · ' + (key === 'tpl-admin' ? 'Admin' : 'Seller') + ' (' + made.frames + (made.frames === 1 ? ' frame' : ' frames') + (made.bodies ? ', ' + made.bodies + (made.bodies === 1 ? ' template body' : ' template bodies') : '') + ')');
    }
  }

  // 3d · release 1.8.1 "Audit fixes for the Panel pages": three named in-place repairs of the frames 1.8.0 made. Each one checks the shape of what it edits;
  // a node that was changed by hand, or is not the plugin's, is reported and left as it is. Nothing is renamed; the only deletion is a member card that does not fit.
  const fix181 = { minH: [], cards: [], cb: false };
  const panelRepair = !blockedBy(['Sidebar', 'Topbar']).length;
  if (panelRepair) {
    ['tpl-admin', 'tpl-seller'].forEach(function (key) {
      const shell = panelShellNames(key);
      T[key].host.children.forEach(function (scr) {
        if (scr.type !== 'FRAME' || shell.indexOf(scr.name) < 0 || scr.getPluginData(PLUGIN_TAG) !== '1') return;
        const sb = scr.children[0], col = scr.children[1];
        if (scr.layoutMode !== 'HORIZONTAL' || !sb || sb.type !== 'INSTANCE' || sb.name !== 'Sidebar' || !col || col.type !== 'FRAME' || col.name !== 'Column') { log('ℹ skipped minimum height of ' + scr.name + ': it is not the plugin\'s page shape'); return; }
        const m = scr.minHeight || 0;
        if (scr.layoutSizingVertical !== 'HUG') { if (scr.height < PANEL_MIN_H - 0.5) log('ℹ skipped minimum height of ' + scr.name + ': its height is fixed at ' + Math.round(scr.height) + ' px (set by hand)'); return; }
        if (m >= PANEL_MIN_H) return;
        if (m) { log('ℹ skipped minimum height of ' + scr.name + ': it has its own minimum height (' + m + ' px)'); return; }
        fix181.minH.push({ key: key, scr: scr, old: scr.height });
      });
    });
    const phone = T['tpl-admin'].host.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Shared · Members · Admin (phone)' && n.getPluginData(PLUGIN_TAG) === '1'; })[0];
    const main = phone && phone.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Main'; })[0];
    if (main) ADMIN_MEMBERS.slice(ADMIN_PHONE_CARDS).forEach(function (mem) {
      const c = main.children.filter(function (n) { return n.name === mem.name; })[0];
      if (!c) return;
      const ok = c.type === 'FRAME' && c.layoutMode === 'VERTICAL' && c.children.map(function (k) { return k.name; }).join() === 'head,role,badges' && !!c.findOne(function (k) { return k.type === 'TEXT' && k.characters === mem.name; });
      if (ok) fix181.cards.push(c); else log('ℹ skipped member card ' + mem.name + ' on Shared · Members · Admin (phone): it is not the plugin\'s card');
    });
  }
  const cbRec = S.sets.CheckboxRow;
  if (cbRec && cbRec.set && own('CheckboxRow') && cbRec.set.width > CHECKBOXROW_OPTS.width + 0.5) {
    const cs = cbRec.set, row = cs.parent, doc = row && row.name === 'Component + usage' && row.type === 'FRAME';
    // the ten 1.8.0 variants, and the two State=Saving variants when 1.10.0 (step 2g) added them in this run or before
    const names = cs.children.map(function (c) { return c.name; });
    const base = combos(CHECKBOXROW_AXES_180).map(variantName), all = combos(CHECKBOXROW_AXES).map(variantName);
    const ok = doc && names.length === new Set(names).size && base.every(function (nm) { return names.indexOf(nm) >= 0; }) && names.every(function (nm) { return all.indexOf(nm) >= 0; });
    if (ok) fix181.cb = true; else log('ℹ skipped CheckboxRow layout: the set or its documentation row was changed by hand');
  }
  if (fix181.minH.length) {
    const byHost = {};
    fix181.minH.forEach(function (f) { (byHost[f.key] = byHost[f.key] || []).push(f); });
    for (const key of Object.keys(byHost)) {
      await onPage(T[key], key === 'tpl-admin' ? 'Admin panel page heights' : 'Seller panel page heights', function (host) {
        byHost[key].forEach(function (f) { f.scr.minHeight = PANEL_MIN_H; });
        fitSection(host);
      });
    }
    added.push('fix minimum height ' + PANEL_MIN_H + ' px of Panel pages (' + fix181.minH.length + ' frames)');
  }
  if (fix181.cards.length) {
    await onPage(T['tpl-admin'], 'Admin phone members', function (host) { fix181.cards.forEach(function (c) { c.remove(); }); });
    added.push('fix Shared · Members · Admin (phone): ' + fix181.cards.length + ' member cards that do not fit removed');
  }
  if (fix181.cb) {
    const cs = S.sets.CheckboxRow.set;
    await onPage(pageOf(cs), 'CheckboxRow layout', function () {
      gridVariants(cs, CHECKBOXROW_AXES, CHECKBOXROW_OPTS);
      const usage = cs.parent.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Usage' && n.width > cs.width + 0.5 && n.layoutMode === 'HORIZONTAL'; })[0];
      if (usage) { usage.resize(cs.width, usage.height); usage.layoutSizingVertical = 'HUG'; }
      const host = T.forms.host; fitSection(host);
    });
    added.push('fix CheckboxRow layout (Value in columns, State in rows)');
  }

  // 3e · 1.8.3 templates: the Sellers list (P1), the role editor (B3), dialogs D4 to D6, the unsaved-changes dialog and their phone frames.
  // New frames only, in rows below what each templates host holds; built when every set they place is the plugin's, and only the names the file does not have yet.
  const p183Block = blockedBy(PANEL183_TEMPLATE_NEEDS); if (!tcLoading) p183Block.push('TableCell State=Loading');
  // The frames place these variants by name; a set whose variants were renamed or removed by hand waits.
  const dialog183 = [['Md', 'Destructive', 'Centred'], ['Md', 'Default', 'Centred'], ['Sm', 'Default', 'Centred'], ['Sm', 'Destructive', 'Centred'], ['Sm', 'Destructive', 'Sheet']].map(function (v) { return { Size: v[0], Tone: v[1], Layout: v[2] }; });
  [['CheckboxRow', combos(CHECKBOXROW_AXES_180)], ['Textarea', combos(TEXTAREA_AXES)], ['Dialog', dialog183]].forEach(function (d) {
    const rec = S.sets[d[0]];
    if (p183Block.indexOf(d[0]) < 0 && rec && rec.set && missingCombos(rec, d[1]).length) p183Block.push(d[0] + ' variants (' + missingCombos(rec, d[1]).map(variantName).join('; ') + ')');
  });
  if (p183Block.length) log('ℹ skipped Panel 1.8.3 templates: they need the plugin\'s ' + p183Block.join(', '));
  else {
    const keys = ['tpl-admin', 'tpl-seller'];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]; const present = T[key].host.children.map(function (c) { return c.name; });
      const missing = panel183Defs()[key].map(function (d) { return d[1]; }).filter(function (n) { return present.indexOf(n) < 0; });
      if (!missing.length) continue;
      let made = null;
      await onPage(T[key], key === 'tpl-admin' ? 'Admin panel templates 1.8.3' : 'Seller panel templates 1.8.3', function (host) { made = addPanelTemplates(host, key, missing, panel183Defs, PANEL183_ROWS); fitSection(host); });
      added.push('templates Panel 1.8.3 · ' + (key === 'tpl-admin' ? 'Admin' : 'Seller') + ' (' + made.frames + (made.frames === 1 ? ' frame' : ' frames') + (made.bodies ? ', ' + made.bodies + (made.bodies === 1 ? ' template body' : ' template bodies') : '') + ')');
    }
  }

  // 3g · 1.9.0 "Seller setup": S1 in each seller state, the steps S2 to S6, their state boards and phone frames, in new rows on Templates · Seller.
  // Built when every set they place is the plugin's and has the 1.9.0 properties, and only the frames the file does not have yet.
  const setupBlock = blockedBy(SETUP_TEMPLATE_NEEDS).concat(setupLacks());
  // The frames place the new sets' variants and set their properties by name; a set changed by hand waits, as in 3e.
  [['FieldStatus', combos(FIELD_STATUS_AXES), ['Text']], ['DataRow', combos(DATAROW_AXES).filter(function (p) { return !DATAROW_SKIP(p); }), DATAROW_KEYS], ['FormActionBar', combos(FAB_AXES), ['Show status', 'Show secondary']]].forEach(function (d) {
    const rec = S.sets[d[0]];
    if (setupBlock.indexOf(d[0]) >= 0 || !rec || !rec.set) return;
    const miss = missingCombos(rec, d[1]); const keys = d[2].filter(function (k) { return !rec.keys[k]; });
    if (miss.length) setupBlock.push(d[0] + ' variants (' + miss.map(variantName).join('; ') + ')');
    if (keys.length) setupBlock.push(d[0] + ' properties (' + keys.join(', ') + ')');
  });
  if (setupBlock.length) log('ℹ skipped Seller setup templates: they need the plugin\'s ' + setupBlock.join(', '));
  else {
    const present = T['tpl-seller'].host.children.map(function (c) { return c.name; });
    const missing = setupNames().filter(function (n) { return present.indexOf(n) < 0; });
    if (missing.length) {
      let made = null;
      await onPage(T['tpl-seller'], 'Seller setup templates', function (host) { made = addPanelTemplates(host, 'tpl-seller', missing, setupDefs, SETUP_ROWS); fitSection(host); });
      added.push('templates Seller setup (' + made.frames + ' frames)');
    }
    const dark190 = DARK_190.filter(function (n) { return T['tpl-dark'].host.children.every(function (c) { return c.name !== n + ' · Dark'; }); }).map(function (n) {
      return T['tpl-seller'].host.children.filter(function (c) { return c.type === 'FRAME' && c.name === n && c.getPluginData(PLUGIN_TAG) === '1'; })[0];
    }).filter(Boolean);
    if (dark190.length) {
      await onPage(T['tpl-dark'], 'Dark preview 1.9.0', function (host) {
        let x = rightEdge(host) + 160; const ref = host.children.filter(function (n) { return n.type === 'FRAME' && n.height > 400; })[0]; const y = ref ? ref.y : 240;
        dark190.forEach(function (src) { const c = src.clone(); c.name = src.name + ' · Dark'; host.appendChild(c); c.x = x; c.y = y; x += c.width + 160; applyTheme(c, 'dark'); added.push('dark preview ' + c.name); });
        fitSection(host);
      });
    }
  }

  // 3h · 1.10.0 "Seller admin": Sellers (Phase 3), Seller review, Seller detail, Seller settings and their dialogs on Templates · Admin, the store
  // profile on Templates · Seller, and two dark previews. Built when every set they place is the plugin's with its 1.9.0 and 1.10.0 parts.
  const adminBlock = blockedBy(SELLER_ADMIN_TEMPLATE_NEEDS).concat(setupLacks(), sellerAdminLacks());
  [['CheckboxRow', combos(CHECKBOXROW_AXES)], ['SettingRow', combos(SETTINGROW_AXES)], ['Dialog', combos(DIALOG_AXES).filter(function (p) { return !(p.Layout === 'Sheet' && p.Size === 'Md'); })],
    ['DataRow', combos(DATAROW_AXES).filter(function (p) { return !DATAROW_SKIP(p); })], ['FormActionBar', combos(FAB_AXES)]].forEach(function (d) {
    const rec = S.sets[d[0]];
    if (adminBlock.indexOf(d[0]) >= 0 || !rec || !rec.set) return;
    const miss = missingCombos(rec, d[1]);
    if (miss.length) adminBlock.push(d[0] + ' variants (' + miss.map(variantName).join('; ') + ')');
  });
  if (adminBlock.length) log('ℹ skipped Seller admin templates: they need the plugin\'s ' + adminBlock.join(', '));
  else {
    const keys = ['tpl-admin', 'tpl-seller'];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]; const present = T[key].host.children.map(function (c) { return c.name; });
      const missing = sellerAdminNames(key).filter(function (n) { return present.indexOf(n) < 0; });
      if (!missing.length) continue;
      let made = null;
      await onPage(T[key], key === 'tpl-admin' ? 'Seller admin templates · Admin' : 'Seller admin templates · Seller', function (host) { made = addPanelTemplates(host, key, missing, sellerAdminDefs, SELLER_ADMIN_ROWS); fitSection(host); });
      added.push('templates Seller admin · ' + (key === 'tpl-admin' ? 'Admin' : 'Seller') + ' (' + made.frames + (made.frames === 1 ? ' frame' : ' frames') + (made.bodies ? ', ' + made.bodies + (made.bodies === 1 ? ' template body' : ' template bodies') : '') + ')');
    }
    const dark1100 = DARK_1100.filter(function (n) { return T['tpl-dark'].host.children.every(function (c) { return c.name !== n + ' · Dark'; }); }).map(function (n) {
      return T['tpl-admin'].host.children.concat(T['tpl-seller'].host.children).filter(function (c) { return c.type === 'FRAME' && c.name === n && c.getPluginData(PLUGIN_TAG) === '1'; })[0];
    }).filter(Boolean);
    if (dark1100.length) {
      await onPage(T['tpl-dark'], 'Dark preview 1.10.0', function (host) {
        let x = rightEdge(host) + 160; const ref = host.children.filter(function (n) { return n.type === 'FRAME' && n.height > 400; })[0]; const y = ref ? ref.y : 240;
        dark1100.forEach(function (src) { const c = src.clone(); c.name = src.name + ' · Dark'; host.appendChild(c); c.x = x; c.y = y; x += c.width + 160; applyTheme(c, 'dark'); added.push('dark preview ' + c.name); });
        fitSection(host);
      });
    }
  }

  // 3 · templates
  const tplKeys = Object.keys(PHONE_TEMPLATES);
  for (let i = 0; i < tplKeys.length; i++) {
    const key = tplKeys[i]; const def = PHONE_TEMPLATES[key];
    const present = T[key].host.children.map(function (c) { return c.name; });
    if (def.names.every(function (n) { return present.indexOf(n) >= 0; })) continue;
    await onPage(T[key], key === 'tpl-seller' ? 'Seller phone templates' : 'Admin phone template', function (host) {
      const ref = host.children.filter(function (n) { return n.type === 'FRAME' && n.height > 400; })[0];
      const y = ref ? ref.y : 240; let x = rightEdge(host) + 160;
      def.make().forEach(function (scr) {
        if (present.indexOf(scr.name) >= 0) { scr.remove(); return; }
        host.appendChild(scr); scr.x = x; scr.y = y; x += scr.width + 160; added.push('template ' + scr.name);
      });
      fitSection(host);
    });
  }

  // 3f · release 1.8.4 "Fixes from the 1.8.3 real-Figma run": two in-place repairs; a node or style changed by hand is reported and left as it is.
  // (a) Effect styles whose colour is bound (Focus/Ring, Ring/Urgent) were saved with spread 0 by Figma's setBoundVariableForEffect, so the rings
  //     did not show. Only the layers that carry that bug's mark (colour bound, spread 0 where the spec has one) get the spec spread back, their
  //     binding kept, and only when that makes the whole style match the spec. A style that differs in any other way, a spread set by hand
  //     included, or a name held by more than one effect style, is reported and left. Styles without a bound colour never met the bug.
  const fx184 = []; const estyles = await figma.getLocalEffectStylesAsync();
  SPEC.effects.forEach(function (e) {
    if (!e.layers.some(function (l) { return l.token; })) return;
    const named = estyles.filter(function (st) { return st.name === e.name; });
    if (!named.length || named.every(function (st) { return !effectDiff(st.effects, e); })) return;
    if (named.length > 1) { log('ℹ skipped effect style ' + e.name + ': the file has ' + named.length + ' effect styles with that name'); return; }
    const st = named[0], cur = st.effects;
    const bugged = function (fx, l) { return !!(l && l.token && l.spread && fx.type === l.type && fx.boundVariables && fx.boundVariables.color && !fx.spread); };
    const next = cur.map(function (fx, i) { return bugged(fx, e.layers[i]) ? Object.assign({}, fx, { spread: e.layers[i].spread }) : fx; });
    if (effectDiff(next, e)) { log('ℹ skipped effect style ' + e.name + ': it was changed by hand (' + effectDiff(cur, e) + ')'); return; }
    fx184.push({ st: st, e: e, next: next });
  });
  // The mock cannot show how Figma takes a bound effect written back, so a refused write is reported and the run goes on,
  // and the style is read back: a spread or a colour binding Figma did not keep is reported, not counted as fixed.
  for (const f of fx184) {
    if (!(await safe('repair effect style ' + f.e.name, function () { f.st.effects = f.next; return true; }))) continue;
    const left = effectDiff(f.st.effects, f.e);
    if (left) log('⚠ effect style ' + f.e.name + ' still differs from the spec after the repair (' + left + '): fix it in the style editor by hand');
    else added.push('fix effect style ' + f.e.name + ': spread ' + f.e.layers.map(function (l) { return l.spread; }).join(' and ') + ' px');
  }
  // (b) The Main frame of the plugin's phone screens scrolls vertically (as phoneScreen now makes it), so a list longer than the screen
  //     continues below the fold instead of sticking out (the seller Members and Roles phone screens in the real-Figma Audit).
  const phones184 = {}; const seen184 = {}; let nPhones = 0;
  Object.keys(T).forEach(function (key) {
    const host = T[key] && T[key].host;
    if (!host || !host.children || seen184[host.id]) return;
    seen184[host.id] = true;
    host.children.forEach(function (scr) {
      if (scr.type !== 'FRAME' || scr.getPluginData(PLUGIN_TAG) !== '1' || !/\(phone\)$/.test(scr.name)) return;
      const main = scr.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Main'; })[0];
      // Dialog sheet scenes have no Main; the phone role editor hugs the whole page, so its Main clips nothing. BOTH scrolls vertically too.
      if (!main || !main.clipsContent || main.overflowDirection === 'VERTICAL' || main.overflowDirection === 'BOTH') return;
      if (main.layoutMode !== 'VERTICAL' || (main.overflowDirection && main.overflowDirection !== 'NONE')) { log('ℹ skipped scrolling of ' + scr.name + ': its Main frame was changed by hand'); return; }
      (phones184[key] = phones184[key] || []).push(main); nPhones++;
    });
  });
  for (const key of Object.keys(phones184)) {
    await onPage(T[key], 'Phone screens scroll', function () { phones184[key].forEach(function (m) { m.overflowDirection = 'VERTICAL'; }); });
  }
  if (nPhones) added.push('fix phone screens: Main scrolls vertically (' + nPhones + ' frames)');

  // 4 · documentation pages (only edits what the release changed)
  const sizeTable = findTable(T.spacing.host, 'Token|Desktop|Touch|Use');
  const newSizes = ['size/bottom-bar', 'size/topbar-phone', 'size/auth-card', 'size/dialog-sm', 'size/dialog-md', 'size/form-max'].map(function (n) { return SPEC.dimension.filter(function (d) { return d.name === n; })[0]; })
    .filter(function (d) { return d && sizeTable && !sizeTable.findOne(function (n) { return n.type === 'TEXT' && n.characters === d.name; }); });
  if (newSizes.length) {
    await onPage(T.spacing, 'Spacing page', function () { newSizes.forEach(function (d) { appendTableRow(sizeTable, [d.name, d.desktop + ' px', d.touch + ' px', SIZE_USE[d.name]], [260, 160, 160, 600]); }); fitSection(T.spacing.host); });
    newSizes.forEach(function (d) { added.push('size table row ' + d.name); });
  }
  const logTable = findTable(T.changelog.host, 'Version|Date|Changes');
  const newReleases = RELEASES.filter(function (r) { return logTable && !logTable.findOne(function (n) { return n.type === 'TEXT' && n.characters === r.version; }); });
  if (newReleases.length) {
    await onPage(T.changelog, 'Changelog', function () { newReleases.forEach(function (r) { appendTableRow(logTable, [r.version, r.date, r.changes], CHANGELOG_WIDTHS); }); fitSection(T.changelog.host); });
    newReleases.forEach(function (r) { added.push('changelog row ' + r.version); });
  }
  const meta = { Version: SPEC.version, Updated: RELEASE.date };
  const coverEdits = [];
  const coverOf = function (k) { const f = T.cover.host.findOne(function (n) { return n.type === 'FRAME' && n.name === k && n.children.length === 2; }); const t = f && f.children[1]; return t && t.type === 'TEXT' ? t : null; };
  if (coverOf('Version') && semverLess(coverOf('Version').characters, SPEC.version)) Object.keys(meta).forEach(function (k) { const t = coverOf(k); if (t) coverEdits.push([t, meta[k]]); });
  if (coverEdits.length) { await onPage(T.cover, 'Cover', function () { coverEdits.forEach(function (e) { e[0].characters = e[1]; }); }); added.push('cover version'); }

  // 5 · Starter layout: sections that grew in this or an earlier update must not cover the next section.
  restackSections().forEach(function (a) { added.push(a); });

  await flush();
  reportOverlaps();
  if (semverLess(figma.root.getPluginData('version') || '1.0.0', SPEC.version)) { figma.root.setPluginData('version', SPEC.version); added.push('file version ' + SPEC.version); }
  if (!added.length) log('✓ Library is already at ' + SPEC.version + '. Nothing to add.');
  else {
    log('✓ Added to the library (' + SPEC.version + '):'); added.forEach(function (a) { log('    + ' + a); });
    const except = [topbarFix.length ? 'the old phone topbar frame swapped for PhoneTopbar in ' + topbarFix.length + ' phone templates' : '', scrimFix.length ? 'the drawer scrim re-bound to bg/scrim in ' + scrimFix.length + ' templates' : '', inputRenamed ? 'the ' + inputRenamed + ' existing Input variants named Type=Text' : '', tcMade ? 'the ' + tcMade + ' State=Loading variants added to the existing TableCell set' : '', prefChanged ? 'the preferred swap values of the Field Control slot' : '', fix181.minH.length ? 'the minimum height set on ' + fix181.minH.length + ' Panel pages' : '', fix181.cards.length ? 'the ' + fix181.cards.length + ' member cards that do not fit removed from the admin phone members screen' : '', fix181.cb ? 'the CheckboxRow variants re-laid out' : ''].filter(Boolean);
    log('Nothing was deleted or rebuilt' + (except.length ? ', except ' + except.join(' and ') : '') + '. The existing Sidebar keeps its drawn brand mark (a new build uses BrandMark). Next: run Audit file, then Export tokens (the diff shows only the tokens added since this file\'s version, and the version line).');
  }
  post({ type: 'done', report: S.report, added: added });
}

// ---------------------------------------------------------------- state for commands run on an existing file
async function loadState() {
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  const byName = {}; colls.forEach(function (c) { byName[c.name] = c; });
  if (!byName.Color || !byName.Dimension) throw new Error('This file has no MondaPac library. Build it first.');
  async function vars(c) { const out = {}; if (!c) return out; for (let i = 0; i < c.variableIds.length; i++) { const v = await figma.variables.getVariableByIdAsync(c.variableIds[i]); if (v) out[v.name] = v; } return out; }
  S.color = await vars(byName.Color); S.colorDark = await vars(byName['Color · Dark']);
  S.dim = await vars(byName.Dimension); S.dimTouch = await vars(byName['Dimension · Touch']);
  // Primitives by "family/step" (the variable name without "color/"), so Update library can add missing ones (1.7.0).
  S.prim = {}; S.primColl = byName.Primitives || null;
  const pv = await vars(byName.Primitives); Object.keys(pv).forEach(function (k) { S.prim[k.replace(/^color\//, '')] = pv[k]; });
  const cm = byName.Color.modes; const dm = byName.Dimension.modes;
  S.modes.color = cm.length > 1; S.modes.dim = dm.length > 1;
  S.colorModes = { collection: byName.Color, light: cm[0].modeId, dark: cm[1] ? cm[1].modeId : null, darkCollection: byName['Color · Dark'] || null, darkAlt: byName['Color · Dark'] ? byName['Color · Dark'].modes[0].modeId : null };
  S.dimModes = { collection: byName.Dimension, desktop: dm[0].modeId, touch: dm[1] ? dm[1].modeId : null, touchCollection: byName['Dimension · Touch'] || null, touchAlt: byName['Dimension · Touch'] ? byName['Dimension · Touch'].modes[0].modeId : null };
  return byName;
}
function pairMaps(a, b) { const ab = {}, ba = {}; Object.keys(a).forEach(function (k) { if (b[k]) { ab[a[k].id] = b[k]; ba[b[k].id] = a[k]; } }); return { ab: ab, ba: ba }; }

async function themeSelection(theme) {
  await loadState();
  const sel = figma.currentPage.selection;
  if (!sel.length) { post({ type: 'error', message: 'Select one or more frames first.' }); return; }
  sel.forEach(function (n) { applyTheme(n, theme); });
  post({ type: 'done', report: ['✓ ' + (theme === 'dark' ? 'Dark' : 'Light') + ' theme applied to ' + sel.length + ' layer(s).'] });
}
async function densitySelection(density) {
  await loadState();
  const sel = figma.currentPage.selection;
  if (!sel.length) { post({ type: 'error', message: 'Select one or more frames first.' }); return; }
  const m = pairMaps(S.dim, S.dimTouch);
  sel.forEach(function (n) {
    if (S.modes.dim) n.setExplicitVariableModeForCollection(S.dimModes.collection, density === 'touch' ? S.dimModes.touch : S.dimModes.desktop);
    else rebindTree(n, density === 'touch' ? m.ab : m.ba);
    n.setPluginData('density', density);
  });
  post({ type: 'done', report: ['✓ ' + (density === 'touch' ? 'Touch' : 'Desktop') + ' density applied to ' + sel.length + ' layer(s).'] });
}

// After a plan upgrade: merge "Color · Dark" and "Dimension · Touch" into modes, rebind every layer,
// and move the Starter sections onto their own pages.
async function upgradeModes() {
  await figma.loadAllPagesAsync();
  await loadState();
  const report = []; let blocked = false;
  const jobs = [];
  if (!S.modes.color && S.colorModes.darkCollection) jobs.push({ kind: 'theme', value: 'dark', main: S.colorModes.collection, alt: S.colorModes.darkCollection, altMode: S.colorModes.darkAlt, a: S.color, b: S.colorDark, modeName: 'Dark' });
  if (!S.modes.dim && S.dimModes.touchCollection) jobs.push({ kind: 'density', value: 'touch', main: S.dimModes.collection, alt: S.dimModes.touchCollection, altMode: S.dimModes.touchAlt, a: S.dim, b: S.dimTouch, modeName: 'Touch' });
  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    const mode = tryAddMode(job.main, job.modeName);
    if (!mode) { blocked = true; report.push('ℹ ' + job.main.name + ': still one mode per collection on this plan.'); continue; }
    Object.keys(job.a).forEach(function (k) { const alt = job.b[k]; if (alt) job.a[k].setValueForMode(mode, alt.valuesByMode[job.altMode]); });
    const map = pairMaps(job.a, job.b).ba;
    let rebound = 0, switched = 0;
    figma.root.children.forEach(function (page) {
      page.findAll(function () { return true; }).forEach(function (n) {
        rebound += rebindNode(n, map);
        if (n.getPluginData(job.kind) === job.value) { try { n.setExplicitVariableModeForCollection(job.main, mode); switched++; } catch (e) { /* layer type has no modes */ } }
      });
    });
    const altName = job.alt.name; job.alt.remove();
    report.push('✓ ' + job.main.name + ': added mode "' + job.modeName + '", rebound ' + rebound + ' layers, switched ' + switched + ' frames, removed "' + altName + '".');
  }
  if (!jobs.length) report.push('✓ Variables already use modes.');
  // Split Starter sections into pages
  const compact = figma.root.children.filter(function (p) { return p.getPluginData(PLUGIN_TAG) === 'page' && p.getPluginData('layout') === 'compact'; });
  if (compact.length) {
    const made = tryCreatePages(PAGES.length);
    if (!made) { blocked = true; report.push('ℹ Pages: still limited to 3 per file; sections kept.'); }
    else {
      const sections = {};
      compact.forEach(function (p) { p.children.forEach(function (n) { if (n.type === 'SECTION' && n.getPluginData('key')) sections[n.getPluginData('key')] = n; }); });
      const at = figma.root.children.indexOf(compact[0]);
      made.forEach(function (p, i) {
        const d = PAGES[i]; p.name = d[1]; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', d[0]); p.setPluginData('layout', 'full');
        figma.root.insertChild(at + i, p);
        const sec = sections[d[0]]; if (sec) { p.appendChild(sec); sec.x = 0; sec.y = 0; }
      });
      await figma.setCurrentPageAsync(made[0]);
      compact.forEach(function (p) { if (!p.children.length) p.remove(); else p.name = p.name + ' (leftovers)'; });
      report.push('✓ Pages: moved ' + Object.keys(sections).length + ' sections onto ' + PAGES.length + ' pages.');
    }
  }
  if (blocked && !report.some(function (l) { return l.indexOf('✓ Color') === 0 || l.indexOf('✓ Pages') === 0 || l.indexOf('✓ Dimension') === 0; })) {
    post({ type: 'error', message: 'This file is still on the Starter plan limits (1 mode per collection, 3 pages). Upgrade the Figma plan, then run this again.', report: report }); return;
  }
  post({ type: 'done', report: report });
}

// ---------------------------------------------------------------- audit (design lint for the whole file)
const AUDIT_LIST = 25;
// What differs between an effect style's effects and its spec layers: '' when they match. Colours are left out (a ring's colour is bound
// to a variable and changes with the theme); the shape is compared: layer count, type, offset, blur and spread.
function effectDiff(effects, e) {
  if (effects.length !== e.layers.length) return effects.length + (effects.length === 1 ? ' layer' : ' layers') + ', the spec has ' + e.layers.length;
  const out = [];
  e.layers.forEach(function (l, i) {
    const fx = effects[i];
    if (fx.type !== l.type) { out.push('layer ' + (i + 1) + ' is ' + fx.type); return; }
    [['x', fx.offset.x, l.x], ['y', fx.offset.y, l.y], ['blur', fx.radius, l.blur], ['spread', fx.spread || 0, l.spread]].forEach(function (f) {
      if (Math.abs(f[1] - f[2]) > 0.01) out.push('layer ' + (i + 1) + ' ' + f[0] + ' ' + num(f[1]) + ', spec ' + f[2]);
    });
    // A layer whose colour comes from a token must keep its binding, or the ring stops following the theme.
    if (l.token && !(fx.boundVariables && fx.boundVariables.color)) out.push('layer ' + (i + 1) + ' colour not bound, spec ' + l.token);
  });
  return out.join('; ');
}
async function auditFile() {
  await figma.loadAllPagesAsync();
  const KINDS = { raw: 'Paints not bound to a variable', text: 'Text without a text style', overflow: 'Layers sticking out of their parent', desc: 'Components without a description', focus: 'Focus variants without a focus ring', effect: 'Effect styles that differ from the library spec' };
  const hits = {}; Object.keys(KINDS).forEach(function (k) { hits[k] = {}; });
  function where(n) { const p = []; for (let x = n; x && x.type !== 'PAGE'; x = x.parent) p.unshift(x.name); return p.slice(-4).join(' › '); }
  function hit(k, n, extra) { const key = where(n) + (extra ? ' ' + extra : ''); hits[k][key] = (hits[k][key] || 0) + 1; }
  let total = 0;
  figma.root.children.forEach(function (page) {
    page.findAll(function () { return true; }).forEach(function (n) {
      total++;
      const swatch = / · (light|dark)$/.test(n.name);
      if (!swatch && 'fills' in n && Array.isArray(n.fills)) n.fills.forEach(function (p) { if (p.type === 'SOLID' && p.visible !== false && !(p.boundVariables && p.boundVariables.color)) hit('raw', n, '(fill)'); });
      if (!swatch && n.type !== 'COMPONENT_SET' && 'strokes' in n && Array.isArray(n.strokes)) n.strokes.forEach(function (p) { if (p.type === 'SOLID' && p.visible !== false && !(p.boundVariables && p.boundVariables.color)) hit('raw', n, '(stroke)'); });
      if (n.type === 'TEXT' && !n.textStyleId) hit('text', n);
      if ((n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && n.parent.type !== 'COMPONENT_SET')) && !n.description && n.name.indexOf('Icon/') !== 0) hit('desc', n);
      if (n.type === 'COMPONENT' && n.parent.type === 'COMPONENT_SET' && /State=Focus/.test(n.name) && !(n.effects && n.effects.some(function (e) { return e.visible !== false; }))) hit('focus', n);
      const p = n.parent;
      // Only auto-layout parents: free-form compositions (maps, charts, badge overlays) overlap on purpose.
      if (n.visible && p && p.type !== 'PAGE' && p.type !== 'SECTION' && p.layoutMode && p.layoutMode !== 'NONE' && n.absoluteBoundingBox && p.absoluteBoundingBox && !(n.layoutPositioning === 'ABSOLUTE')) {
        const a = n.absoluteBoundingBox, b = p.absoluteBoundingBox;
        const below = a.y + a.height - (b.y + b.height), side = Math.max(a.x + a.width - (b.x + b.width), b.x - a.x, b.y - a.y);
        // 1.8.4: a clipped frame that scrolls vertically (a phone screen's Main) holds content below the fold on purpose.
        const scrolls = p.clipsContent && (p.overflowDirection === 'VERTICAL' || p.overflowDirection === 'BOTH');
        const over = scrolls ? side : Math.max(below, side);
        if (over > 1.5) hit('overflow', n, '+' + Math.round(over) + 'px' + (p.clipsContent ? ' clipped' : ''));
      }
    });
  });
  // 1.8.4: the effect styles the library defines keep the spec's shadows (offset, blur, spread), colour bindings aside.
  (await figma.getLocalEffectStylesAsync()).forEach(function (st) {
    const e = SPEC.effects.filter(function (x) { return x.name === st.name; })[0];
    if (!e) return;
    const diff = effectDiff(st.effects, e);
    if (diff) { hits.effect[st.name + ' (' + diff + ')'] = 1; }
  });
  const report = ['Audit of ' + total + ' layers:'];
  Object.keys(KINDS).forEach(function (k) {
    const list = Object.keys(hits[k]); const count = list.reduce(function (a, x) { return a + hits[k][x]; }, 0);
    report.push((count ? '⚠ ' : '✓ ') + KINDS[k] + ': ' + count + (count ? ' (' + list.length + ' unique)' : ''));
    list.slice(0, AUDIT_LIST).forEach(function (x) { report.push('    ' + x + (hits[k][x] > 1 ? ' ×' + hits[k][x] : '')); });
    // 1.8.4: say how many were left out, so a long list does not hide an entry (the 1.8.0 seller phone cards were below the 25th).
    if (list.length > AUDIT_LIST) report.push('    … and ' + (list.length - AUDIT_LIST) + ' more');
  });
  post({ type: 'done', report: report });
}

// ---------------------------------------------------------------- export (DTCG files + CSS), byte-compatible with docs/design/tokens
// Ordered object so the JSON keeps Figma's order (plain JS objects would sort numeric keys).
function OM() { return { __om: true, keys: [], map: {} }; }
function omSet(o, k, v) { if (!Object.prototype.hasOwnProperty.call(o.map, k)) o.keys.push(k); o.map[k] = v; return v; }
function omGet(o, k) { return Object.prototype.hasOwnProperty.call(o.map, k) ? o.map[k] : omSet(o, k, OM()); }
function nestInto(root, path, leaf) { const parts = path.split('/'); let cur = root; for (let i = 0; i < parts.length - 1; i++) cur = omGet(cur, parts[i]); omSet(cur, parts[parts.length - 1], leaf); }
function obj(pairs) { const o = OM(); pairs.forEach(function (p) { omSet(o, p[0], p[1]); }); return o; }
function pyStr(s) { return JSON.stringify(s).replace(/[\u0080-￿]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); }); }
function dumps(v, ind) {
  ind = ind || '';
  if (v && v.__om) {
    if (!v.keys.length) return '{}';
    const inner = ind + '  ';
    return '{\n' + v.keys.map(function (k) { return inner + pyStr(k) + ': ' + dumps(v.map[k], inner); }).join(',\n') + '\n' + ind + '}';
  }
  if (typeof v === 'string') return pyStr(v);
  return String(v);
}
function hex2(n) { return ('0' + Math.round(n * 255).toString(16)).slice(-2).toUpperCase(); }
// Colours with alpha below 1 (bg/scrim) export as #RRGGBBAA; opaque colours keep #RRGGBB.
function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a !== undefined && c.a < 1 ? hex2(c.a) : ''); }
function num(n) { return String(+(+n).toFixed(3)); }
function cssName(n) { return '--mp-' + n.replace(/\//g, '-'); }
const WEIGHT = { Regular: 400, Medium: 500, SemiBold: 600, 'Semi Bold': 600, Bold: 700 };

async function exportTokens(version) {
  const byName = await loadState();
  async function list(c) { const out = []; if (!c) return out; for (let i = 0; i < c.variableIds.length; i++) { const v = await figma.variables.getVariableByIdAsync(c.variableIds[i]); if (v) out.push(v); } return out; }
  async function aliasPath(val) { if (val && val.type === 'VARIABLE_ALIAS') { const t = await figma.variables.getVariableByIdAsync(val.id); return t ? t.name : null; } return null; }
  async function resolveHex(val) {
    let guard = 0;
    while (val && val.type === 'VARIABLE_ALIAS' && guard++ < 10) { const t = await figma.variables.getVariableByIdAsync(val.id); if (!t) return null; const c = await figma.variables.getVariableCollectionByIdAsync(t.variableCollectionId); val = t.valuesByMode[c.modes[0].modeId]; }
    return val && val.r !== undefined ? toHex(val) : null;
  }
  const files = {};
  // primitives
  const prim = OM();
  // Sorted by family, then by numeric step: a file updated from an older release has the newer primitives at the end
  // of the collection, and the export must match a fresh build (the spec lists primitives in this order).
  const primStep = function (v) { const p = v.name.split('/'); return [p[1], +p[2]]; };
  const primVars = (await list(byName.Primitives)).sort(function (a, b) { const x = primStep(a), y = primStep(b); return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : x[1] - y[1]); });
  primVars.forEach(function (v) { nestInto(prim, v.name, obj([['$type', 'color'], ['$value', toHex(v.valuesByMode[byName.Primitives.modes[0].modeId])]])); });
  files['primitives.json'] = obj([['$description', 'MondaPac primitives. Do not use directly in UI; use semantic tokens.'], ['color', omGet(prim, 'color')]]);
  // semantic colour, light + dark
  const colorVars = await list(byName.Color);
  const darkByName = {}; (await list(byName['Color · Dark'])).forEach(function (v) { darkByName[v.name] = v; });
  const css = { light: [], dark: [] };
  for (let t = 0; t < 2; t++) {
    const theme = t ? 'dark' : 'light'; const body = OM();
    for (let i = 0; i < colorVars.length; i++) {
      const v = colorVars[i];
      const val = theme === 'light' ? v.valuesByMode[S.colorModes.light] : (S.colorModes.dark ? v.valuesByMode[S.colorModes.dark] : (darkByName[v.name] ? darkByName[v.name].valuesByMode[S.colorModes.darkAlt] : null));
      if (!val) continue;
      const ap = await aliasPath(val);
      const leaf = [['$type', 'color'], ['$value', ap ? '{' + ap.replace(/\//g, '.') + '}' : toHex(val)]];
      if (v.description) leaf.push(['$description', v.description]);
      nestInto(body, v.name, obj(leaf));
      css[theme].push('  ' + cssName('color/' + v.name) + ': ' + (await resolveHex(val)) + ';');
    }
    files['color.' + theme + '.json'] = obj([['$description', 'MondaPac semantic colour, ' + theme + ' theme. Aliases point to primitives.json.'], ['color', body]]);
  }
  // dimensions, desktop + touch
  const dimVars = await list(byName.Dimension);
  const touchByName = {}; (await list(byName['Dimension · Touch'])).forEach(function (v) { touchByName[v.name] = v; });
  const dimCss = { desktop: [], touch: [] };
  ['desktop', 'touch'].forEach(function (dens) {
    const body = obj([['$description', 'MondaPac dimensions, ' + dens + ' density.']]);
    dimVars.forEach(function (v) {
      const d = v.valuesByMode[S.dimModes.desktop];
      const val = dens === 'desktop' ? d : (S.dimModes.touch ? v.valuesByMode[S.dimModes.touch] : (touchByName[v.name] ? touchByName[v.name].valuesByMode[S.dimModes.touchAlt] : d));
      nestInto(body, v.name, obj([['$type', 'dimension'], ['$value', num(val) + 'px']]));
      if (dens === 'desktop' || val !== d) dimCss[dens].push('  ' + cssName(v.name) + ': ' + num(val) + 'px;');
    });
    files['dimension.' + dens + '.json'] = body;
  });
  // typography from text styles
  const typ = OM();
  const tstyles = await figma.getLocalTextStylesAsync();
  tstyles.forEach(function (s) {
    const parts = s.name.split('/'); if (parts.length !== 2) return;
    const ls = s.letterSpacing.unit === 'PERCENT' ? s.letterSpacing.value * s.fontSize / 100 : s.letterSpacing.value;
    const lh = s.lineHeight.unit === 'PIXELS' ? num(s.lineHeight.value) + 'px' : (s.lineHeight.unit === 'PERCENT' ? num(s.lineHeight.value * s.fontSize / 100) + 'px' : 'normal');
    omSet(omGet(typ, parts[0].toLowerCase()), parts[1].toLowerCase().replace(/ /g, '-'), obj([['$type', 'typography'], ['$value', obj([
      ['fontFamily', s.fontName.family], ['fontWeight', WEIGHT[s.fontName.style] || 400], ['fontSize', num(s.fontSize) + 'px'], ['lineHeight', lh], ['letterSpacing', num(ls) + 'px'],
    ])]]));
  });
  files['typography.json'] = obj([['$description', 'MondaPac text styles (match Figma text styles).'], ['typography', typ]]);
  // CSS
  const tyVars = {}; (await list(byName.Typography)).forEach(function (v) { tyVars[v.name] = v.valuesByMode[byName.Typography.modes[0].modeId]; });
  const motion = await list(byName.Motion);
  const estyles = await figma.getLocalEffectStylesAsync();
  async function shadow(s, theme) {
    const parts = [];
    for (let i = 0; i < s.effects.length; i++) {
      const e = s.effects[i]; if (e.type !== 'DROP_SHADOW') continue;
      let c = e.color; const b = e.boundVariables && e.boundVariables.color;
      if (b && theme === 'dark') {
        const lv = await figma.variables.getVariableByIdAsync(b.id);
        const val = S.colorModes.dark ? lv.valuesByMode[S.colorModes.dark] : (darkByName[lv.name] ? darkByName[lv.name].valuesByMode[S.colorModes.darkAlt] : null);
        const h = await resolveHex(val); if (h) c = { r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: e.color.a };
      }
      parts.push(Math.round(e.offset.x) + 'px ' + Math.round(e.offset.y) + 'px ' + Math.round(e.radius) + 'px ' + Math.round(e.spread || 0) + 'px rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + num(c.a) + ')');
    }
    return '  ' + cssName('shadow/' + s.name.toLowerCase().replace(/ /g, '-')) + ': ' + parts.join(', ') + ';';
  }
  const lines = ["/* MondaPac design tokens v" + version + ". Source of truth: the Figma file 'MondaPac Design System'.",
    ' * Do not edit by hand. Change the Figma variables, run the plugin command Export tokens and commit these files. */', ':root {'];
  css.light.forEach(function (l) { lines.push(l); }); dimCss.desktop.forEach(function (l) { lines.push(l); });
  lines.push("  --mp-font-family-sans: '" + (tyVars['font/family/sans'] || 'IBM Plex Sans') + "', system-ui, sans-serif;\n  --mp-font-family-mono: '" + (tyVars['font/family/mono'] || 'IBM Plex Mono') + "', ui-monospace, monospace;");
  tstyles.forEach(function (st) {
    const parts = st.name.split('/'); if (parts.length !== 2) return;
    const key = parts[0].toLowerCase() + '-' + parts[1].toLowerCase().replace(/ /g, '-');
    const fam = st.fontName.family === tyVars['font/family/mono'] ? 'mono' : 'sans';
    const lh = st.lineHeight.unit === 'PIXELS' ? num(st.lineHeight.value) + 'px' : 'normal';
    lines.push('  --mp-text-' + key + ': ' + (WEIGHT[st.fontName.style] || 400) + ' ' + num(st.fontSize) + 'px/' + lh + ' var(--mp-font-family-' + fam + ');');
    const ls = st.letterSpacing.unit === 'PERCENT' ? st.letterSpacing.value * st.fontSize / 100 : st.letterSpacing.value;
    if (+num(ls) !== 0) lines.push('  --mp-text-' + key + '-tracking: ' + num(ls) + 'px;');
  });
  motion.forEach(function (v) { lines.push('  ' + cssName('motion/' + v.name) + ': ' + num(v.valuesByMode[byName.Motion.modes[0].modeId]) + 'ms;'); });
  lines.push('  --mp-motion-easing: cubic-bezier(0.2, 0, 0, 1);');
  for (let i = 0; i < estyles.length; i++) lines.push(await shadow(estyles[i], 'light'));
  lines.push('}\n\n[data-theme="dark"] {');
  css.dark.forEach(function (l) { lines.push(l); });
  for (let i = 0; i < estyles.length; i++) { const bound = estyles[i].effects.some(function (e) { return e.boundVariables && e.boundVariables.color; }); if (bound) lines.push(await shadow(estyles[i], 'dark')); }
  lines.push('}\n\n[data-density="touch"] {');
  dimCss.touch.forEach(function (l) { lines.push(l); });
  lines.push('}');
  const out = {};
  Object.keys(files).forEach(function (k) { out[k] = dumps(files[k]); });
  out['tokens.css'] = lines.join('\n') + '\n';
  figma.root.setPluginData('version', version);
  post({ type: 'export', files: out, version: version });
}

// ---------------------------------------------------------------- entry
figma.showUI(__html__, { width: 420, height: 640, themeColors: true, title: 'MondaPac Design System' });
post({ type: 'init', version: figma.root.getPluginData('version') || SPEC.version, specVersion: SPEC.version });
figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'build') await build(!!msg.force);
    else if (msg.type === 'update') await updateLibrary();
    else if (msg.type === 'theme') await themeSelection(msg.theme);
    else if (msg.type === 'density') await densitySelection(msg.density);
    else if (msg.type === 'upgrade') await upgradeModes();
    else if (msg.type === 'audit') await auditFile();
    else if (msg.type === 'export') await exportTokens(msg.version || SPEC.version);
    else if (msg.type === 'close') figma.closePlugin();
  } catch (e) {
    post({ type: 'error', message: (e && e.message) ? e.message : String(e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : '', report: S.report });
  }
};
