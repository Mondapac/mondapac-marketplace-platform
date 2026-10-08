echo "uid=$(id -u) pid=$$"
echo "env: $(env | sort | tr '\n' ' ')"
echo "open fds: $(ls /proc/self/fd | tr '\n' ' ')"
echo "net ifaces: $(cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' ' | tr '\n' ' ')"
(echo > /dev/tcp/1.1.1.1/53) 2>&1 | head -1
echo "ls /root: $(ls /root 2>&1 | head -1)"; echo "ls /home: $(ls /home 2>&1| head -1)"
echo "write /usr: $(touch /usr/x 2>&1 | head -1)"; echo "write /tmp: $(touch /tmp/x 2>&1 && echo ok)"
echo "ptrace/other procs: $(ls /proc | grep -c '^[0-9]')"
echo "caps: $(grep CapEff /proc/self/status)"; echo "nonewprivs: $(grep NoNewPrivs /proc/self/status)"
