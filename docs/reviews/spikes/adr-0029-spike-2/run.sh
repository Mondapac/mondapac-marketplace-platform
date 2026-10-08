#!/bin/bash
# one file in the sandbox of decision 7: no network, clean env, no creds, read-only root, tmpfs, caps dropped, AS limit
NODE=${NODE:-node}
D=$(pwd)
exec timeout -s KILL ${WALL:-10} bwrap --unshare-all --die-with-parent --new-session --clearenv --setenv PATH /usr/bin:/bin --uid 65534 --gid 65534 \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind "$NODE" /node --ro-bind "$D/node_modules" /app/node_modules --ro-bind "$D/intake.mjs" /app/intake.mjs --ro-bind "$D/$1" /in --cap-drop ALL \
  prlimit ${LIM:---as=8589934592} --cpu=${CPU:-8} -- /node /app/intake.mjs /in
