"""MondaPac icon set: 24 px grid, drawn at 20 px, 1.75 stroke (product glyphs 1.6).
Navigation icons match the approved panel design; the rest follow the same geometry.
Run: python3 icons.py  → writes icons.json, then python3 build.py."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
I = {
 "home": "<path d=\"M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"></path>", "inbox": "<path d=\"M22 12h-6l-2 3h-4l-2-3H2\"></path><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"></path>", "clipboard": "<rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\"></rect><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"></path><path d=\"M12 11h4\"></path><path d=\"M12 16h4\"></path><path d=\"M8 11h.01\"></path><path d=\"M8 16h.01\"></path>", "package": "<path d=\"m7.5 4.27 9 5.15\"></path><path d=\"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z\"></path><path d=\"m3.3 7 8.7 5 8.7-5\"></path><path d=\"M12 22V12\"></path>", "store": "<path d=\"M4 9.5 5.5 4h13L20 9.5\"></path><path d=\"M4 9.5h16v1a2.7 2.7 0 0 1-5.3.7 2.7 2.7 0 0 1-5.4 0A2.7 2.7 0 0 1 4 10.5z\"></path><path d=\"M5.5 12.5V20h13v-7.5\"></path><path d=\"M10 20v-4.5h4V20\"></path>",
 "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"></path><circle cx=\"9\" cy=\"7\" r=\"4\"></circle><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"></path><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"></path>", "wallet": "<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\"></path><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\"></path>", "file-text": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"></path><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"></path><path d=\"M16 13H8\"></path><path d=\"M16 17H8\"></path>", "sliders": "<path d=\"M4 6h10\"></path><path d=\"M18 6h2\"></path><circle cx=\"16\" cy=\"6\" r=\"2\"></circle><path d=\"M4 12h4\"></path><path d=\"M12 12h8\"></path><circle cx=\"10\" cy=\"12\" r=\"2\"></circle><path d=\"M4 18h12\"></path><circle cx=\"18\" cy=\"18\" r=\"2\"></circle>", "shield-check": "<path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10\"></path><path d=\"m9 12 2 2 4-4\"></path>",
 "undo": "<path d=\"M9 14 4 9l5-5\"></path><path d=\"M4 9h10.5a5.5 5.5 0 0 1 0 11H11\"></path>", "badge-check": "<path d=\"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z\"></path><path d=\"m9 12 2 2 4-4\"></path>", "message": "<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"></path>", "help-circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\"></path><path d=\"M12 17h.01\"></path>", "panel-left": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect><path d=\"M9 3v18\"></path>",
 "search": '<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path>',
 "bell": '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>',
 "chevron-down": '<path d="m6 9 6 6 6-6"></path>', "chevron-right": '<path d="m9 18 6-6-6-6"></path>', "chevron-left": '<path d="m15 18-6-6 6-6"></path>',
 "x": '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>', "plus": '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
 "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path><path d="M12 15V3"></path>',
 "columns": '<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M9 3v18"></path><path d="M15 3v18"></path>',
 "more-vertical": '<circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="19" r="1"></circle>',
 "more-horizontal": '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
 "check": '<path d="M20 6 9 17l-5-5"></path>', "minus": '<path d="M5 12h14"></path>',
 "alert-circle": '<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
 "alert-triangle": '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
 "clock": '<circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path>',
 "calendar": '<rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h18"></path>',
 "zap": '<path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>',
 "volume": '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"></path><path d="M16 9a5 5 0 0 1 0 6"></path><path d="M19.4 18.4a9 9 0 0 0 0-12.8"></path>',
 "arrow-up": '<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>', "arrow-down": '<path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path>',
 "arrow-left": '<path d="M19 12H5"></path><path d="m12 19-7-7 7-7"></path>', "arrow-right": '<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>',
 "external-link": '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
 "zoom-in": '<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path><path d="M11 8v6"></path><path d="M8 11h6"></path>',
 "zoom-out": '<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path><path d="M8 11h6"></path>',
 "leaf": '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path>',
 "briefcase": '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
 "ban": '<circle cx="12" cy="12" r="10"></circle><path d="m4.9 4.9 14.2 14.2"></path>',
 "printer": '<path d="M6 9V2h12v7"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect>',
 "truck": '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"></path><path d="M15 18H9"></path><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"></path><circle cx="17" cy="18" r="2"></circle><circle cx="7" cy="18" r="2"></circle>',
 "map-pin": '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle>',
 "star": '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"></path>',
 "file": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path>',
 "send": '<path d="m22 2-7 20-4-9-9-4z"></path><path d="M22 2 11 13"></path>',
 "eye": '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle>',
 "info": '<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>',
 "circle": '<circle cx="12" cy="12" r="9"></circle>',
 "menu": '<path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path>',
 # 1.7.0 "Auth" (identity ux.md section 4): same grid and stroke, lucide-like shapes.
 "eye-off": '<path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7"></path><path d="M14.1 14.2a3 3 0 0 1-4.2-4.2"></path><path d="M17.5 17.5A10.4 10.4 0 0 1 12 19c-7 0-10-7-10-7a13.2 13.2 0 0 1 4.6-5.5"></path><path d="m2 2 20 20"></path>',
 "lock": '<rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>',
 "mail": '<rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path>',
 "key": '<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6"></path><path d="m15.5 7.5 3 3L22 7l-3-3"></path>',
 "user": '<circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 0 0-16 0"></path>',
 "log-out": '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5"></path><path d="M21 12H9"></path>',
 "copy": '<rect x="8" y="8" width="14" height="14" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
 "smartphone": '<rect x="5" y="2" width="14" height="20" rx="2"></rect><path d="M12 18h.01"></path>',
 "trash": '<path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
}
GLYPHS = {
 'meat': '<path d="M6.2 8c2.6-3.2 8.4-3.6 11.3-.1 2.6 3.1 1.6 7.8-2.1 9.8-3.1 1.7-6.8 1-8.8-1.5-1.9-2.3-2.4-5.6-.4-8.2z"></path><circle cx="15" cy="11.2" r="1.7"></circle>',
 'poultry': '<path d="M15.2 4.2a5 5 0 0 1 4.6 6.2c-.7 2.9-3.7 4.4-6.4 3.7l-3.1 3.1"></path><path d="M15.2 4.2c-2.9.7-4.6 3.6-3.9 6.5l-3.1 3.1"></path><path d="M10.3 17.2a1.9 1.9 0 1 1-2.6 2.5 1.9 1.9 0 1 1 .5-3.6"></path>',
 'bakery': '<path d="M4.5 13.6c0-4 3.4-6.6 7.5-6.6s7.5 2.6 7.5 6.6V17a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4.5 17z"></path><path d="m9.2 10.4-1.4 3"></path><path d="m12.7 10-1.4 3.4"></path><path d="m16.1 10.6-1.3 2.8"></path>',
 'pantry': '<path d="M8.6 6.6h6.8l-1.4 2.6c2.9 1.5 4.5 4.2 4.5 6.9a3.4 3.4 0 0 1-3.4 3.4H8.9a3.4 3.4 0 0 1-3.4-3.4c0-2.7 1.6-5.4 4.5-6.9z"></path><path d="M9.2 4.4h5.6"></path><path d="M9.5 14.2h5"></path>',
 'other': '<path d="M12 3.6c1 3 4.6 4.6 4.6 9.1a4.6 4.6 0 0 1-9.2 0c0-2 1-3.4 2-4.4.3 1.5 1 2.4 2 2.7-.5-2.8-.2-5.1.6-7.4z"></path>',
}
FILLED = {'zap', 'more-vertical', 'more-horizontal', 'star'}
out = {}
for k, v in I.items():
    if k in FILLED:
        out[k] = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#3F4756" stroke="none">%s</svg>' % v
    else:
        out[k] = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3F4756" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">%s</svg>' % v
for k, v in GLYPHS.items():
    out['product-' + k] = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3F4756" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">%s</svg>' % v
json.dump(out, open(os.path.join(HERE, 'icons.json'), 'w'), indent=0)
print(len(out), 'icons')
print(len(out), 'icons')
