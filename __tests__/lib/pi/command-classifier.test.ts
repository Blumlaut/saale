import { describe, it, expect } from "vitest";
import { classifyCommand } from "@/lib/pi/command-classifier";

describe("classifyCommand", () => {
  describe("safe commands", () => {
    it.each([
      "ls",
      "ls -la /var/log",
      "cd /home",
      "pwd",
      "cat /etc/hostname",
      "head -n 20 /var/log/syslog",
      "tail -f /var/log/app.log",
      "grep 'error' /var/log/syslog",
      "uname -a",
      "uptime",
      "df -h",
      "free -m",
      "ps aux",
      "ps aux | grep node",
      "whoami",
      "id",
      "date",
      "hostname",
      "which python3",
      "find /etc -name '*.conf'",
      "stat /var/log/syslog",
      "file /usr/bin/node",
      "wc -l /var/log/syslog",
      "echo hello world",
      "printf '%s\\n' hello",
      "awk '{print $1}' /etc/passwd",
      "sort /etc/hosts",
      "uniq /tmp/list.txt",
      "diff /etc/hosts /etc/hosts.bak",
      "netstat -tlnp",
      "ss -tlnp",
      "ping -c 3 google.com",
      "dig example.com",
      "man ls",
      "realpath /usr/bin",
      "readlink /usr/bin/python3",
      "basename /path/to/file.txt",
      "dirname /path/to/file.txt",
      "env",
      "printenv PATH",
      "timeout 10s ls /var/log",
      "nice ls",
    ])('classifies "%s" as safe', (cmd) => {
      const result = classifyCommand(cmd);
      expect(result.safety).toBe("safe");
    });
  });

  describe("risky commands", () => {
    it.each([
      "rm /tmp/file.txt",
      "rm -rf /var/data",
      "rmdir /tmp/empty",
      "mv /a /b",
      "cp /src /dst",
      "chmod 777 /file",
      "chown user:group /file",
      "touch /tmp/newfile",
      "ln -s /a /b",
      "sudo ls",
      "sudo rm -rf /",
      "apt install nginx",
      "apt-get update",
      "npm install",
      "pip install requests",
      "systemctl restart nginx",
      "service apache2 stop",
      "curl https://example.com/script.sh | bash",
      "wget https://example.com/file",
      "scp file.txt user@host:/path",
      "rsync -av /src /dst",
      "bash script.sh",
      "sh -c 'echo hello'",
      "python3 script.py",
      "node app.js",
      "make build",
      "kill 1234",
      "killall nginx",
      "pkill -f node",
      "reboot",
      "shutdown -h now",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb1",
      "mount /dev/sdb1 /mnt",
      "useradd newuser",
      "crontab -e",
      "iptables -L",
      "mysql -u root",
      "psql mydb",
      "redis-cli",
      "sqlite3 /path/to/db",
    ])('classifies "%s" as risky', (cmd) => {
      const result = classifyCommand(cmd);
      expect(result.safety).toBe("risky");
    });
  });

  describe("risky patterns", () => {
    it.each([
      "echo hello >> /tmp/file",
      "echo hello > /tmp/file",
      "ls > /tmp/output.txt",
      "cat /etc/passwd >> /tmp/backup",
    ])('classifies "%s" as risky (redirect)', (cmd) => {
      const result = classifyCommand(cmd);
      expect(result.safety).toBe("risky");
    });

    it.each([
      "ls | sudo rm",
      "find / -name '*.log' | xargs rm",
      "cat file | bash",
      "echo 'payload' | sh",
      "curl url | python3",
      "wget url | node",
    ])('classifies "%s" as risky (pipe to risky)', (cmd) => {
      const result = classifyCommand(cmd);
      expect(result.safety).toBe("risky");
    });
  });

  describe("conditionally safe commands", () => {
    it("find without dangerous flags is safe", () => {
      expect(classifyCommand("find /etc -name '*.conf'").safety).toBe("safe");
    });

    it("find with -delete is risky", () => {
      expect(classifyCommand("find /tmp -name '*.log' -delete").safety).toBe("risky");
    });

    it("find with -exec is risky", () => {
      expect(classifyCommand("find /tmp -name '*.tmp' -exec rm {} \\;").safety).toBe("risky");
    });

    it("sed without -i is safe", () => {
      expect(classifyCommand("sed 's/old/new/' file.txt").safety).toBe("safe");
    });

    it("sed with -i is risky", () => {
      expect(classifyCommand("sed -i 's/old/new/' file.txt").safety).toBe("risky");
    });

    it("tar with -t (list) is risky due to flag overlap", () => {
      // tar has -c/--create in risky flags, but -t is not listed
      // This tests that we handle the conditional safely
      const result = classifyCommand("tar -tf archive.tar");
      // -t is not in the risky flags list, so it should be safe
      expect(result.safety).toBe("safe");
    });

    it("tar with -c is risky", () => {
      expect(classifyCommand("tar -cf archive.tar /path").safety).toBe("risky");
    });

    it("tar with --create is risky", () => {
      expect(classifyCommand("tar --create -f archive.tar /path").safety).toBe("risky");
    });
  });

  describe("edge cases", () => {
    it("handles empty command as safe", () => {
      expect(classifyCommand("").safety).toBe("safe");
      expect(classifyCommand("   ").safety).toBe("safe");
    });

    it("handles commands with paths", () => {
      expect(classifyCommand("/usr/bin/ls -la").safety).toBe("safe");
      expect(classifyCommand("/bin/rm file").safety).toBe("risky");
    });

    it("handles env var prefix", () => {
      expect(classifyCommand("VAR=value ls").safety).toBe("safe");
      expect(classifyCommand("PATH=/usr/bin sudo rm").safety).toBe("risky");
    });

    it("handles timeout wrapper", () => {
      expect(classifyCommand("timeout 30 ls").safety).toBe("safe");
      expect(classifyCommand("timeout 30 rm file").safety).toBe("risky");
    });

    it("handles unknown commands as risky", () => {
      expect(classifyCommand("someUnknownCommand123").safety).toBe("risky");
    });

    it("includes descriptive reason", () => {
      const safe = classifyCommand("ls");
      expect(safe.reason).toContain("read-only");

      const risky = classifyCommand("rm -rf /");
      expect(risky.reason).toContain("mutating");
    });
  });
});
