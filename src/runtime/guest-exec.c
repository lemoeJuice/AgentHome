#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <grp.h>
#include <linux/prctl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define PRINCIPAL_UID_MIN 20000
#define PRINCIPAL_UID_MAX 60000
#define MODEL_RUNTIME_UID 10002
#define OWNER_RUNTIME_UID 10001
#define OWNER_WORKSPACE_UID_MIN 10003
#define OWNER_WORKSPACE_UID_MAX 19999
#define WORKSPACE_RUNTIME_UID_MIN 60001
#define WORKSPACE_RUNTIME_UID_MAX 65535

static void fail(const char *message) {
  perror(message);
  _exit(126);
}

static unsigned long long number(const char *value, const char *field) {
  char *end = NULL;
  errno = 0;
  unsigned long long result = strtoull(value, &end, 10);
  if (errno || !end || *end != '\0' || end == value) {
    fprintf(stderr, "GUEST_EXEC_INVALID:%s\n", field);
    _exit(126);
  }
  return result;
}

static void set_limit(int resource, unsigned long long soft, const char *field) {
  struct rlimit limit = { .rlim_cur = (rlim_t)soft, .rlim_max = (rlim_t)soft };
  if ((unsigned long long)limit.rlim_cur != soft || setrlimit(resource, &limit) != 0) {
    fprintf(stderr, "GUEST_EXEC_RLIMIT_FAILED:%s\n", field);
    _exit(126);
  }
}

int main(int argc, char **argv) {
  if (geteuid() != 0 || getuid() != 0) {
    fprintf(stderr, "GUEST_EXEC_PRIVILEGED_PARENT_REQUIRED\n");
    return 126;
  }
  if (argc < 10 || argv[8][0] != '-' || argv[8][1] != '-' || argv[8][2] != '\0') {
    fprintf(stderr, "GUEST_EXEC_USAGE: uid gid workspace-gid cpu-seconds memory-bytes pids file-bytes -- command [args...]\n");
    return 126;
  }
  unsigned long long uidValue = number(argv[1], "uid");
  unsigned long long gidValue = number(argv[2], "gid");
  unsigned long long workspaceGidValue = number(argv[3], "workspace-gid");
  if ((uidValue != OWNER_RUNTIME_UID && uidValue != MODEL_RUNTIME_UID && !((uidValue >= OWNER_WORKSPACE_UID_MIN && uidValue <= OWNER_WORKSPACE_UID_MAX) || (uidValue >= PRINCIPAL_UID_MIN && uidValue <= PRINCIPAL_UID_MAX) || (uidValue >= WORKSPACE_RUNTIME_UID_MIN && uidValue <= WORKSPACE_RUNTIME_UID_MAX))) || (gidValue != OWNER_RUNTIME_UID && gidValue != MODEL_RUNTIME_UID && !((gidValue >= OWNER_WORKSPACE_UID_MIN && gidValue <= OWNER_WORKSPACE_UID_MAX) || (gidValue >= PRINCIPAL_UID_MIN && gidValue <= PRINCIPAL_UID_MAX) || (gidValue >= WORKSPACE_RUNTIME_UID_MIN && gidValue <= WORKSPACE_RUNTIME_UID_MAX))) || (workspaceGidValue < 10003 || workspaceGidValue > 65535)) {
    fprintf(stderr, "GUEST_EXEC_IDENTITY_OUT_OF_RANGE\n");
    return 126;
  }
  unsigned long long cpuSeconds = number(argv[4], "cpu-seconds");
  unsigned long long memoryBytes = number(argv[5], "memory-bytes");
  unsigned long long pids = number(argv[6], "pids");
  unsigned long long fileBytes = number(argv[7], "file-bytes");
  if (argc < 10 || !cpuSeconds || !memoryBytes || !pids || !fileBytes) return 126;
  set_limit(RLIMIT_CPU, cpuSeconds, "cpu");
  set_limit(RLIMIT_AS, memoryBytes, "address-space");
  set_limit(RLIMIT_NPROC, pids, "process-count");
  set_limit(RLIMIT_FSIZE, fileBytes, "file-size");
  set_limit(RLIMIT_NOFILE, 1024, "open-files");
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) fail("PR_SET_PDEATHSIG");
  gid_t workspaceGroup = (gid_t)workspaceGidValue;
  if (setgroups(1, &workspaceGroup) != 0) fail("setgroups");
  if (setresgid((gid_t)gidValue, (gid_t)gidValue, (gid_t)gidValue) != 0) fail("setresgid");
  if (setresuid((uid_t)uidValue, (uid_t)uidValue, (uid_t)uidValue) != 0) fail("setresuid");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("PR_SET_NO_NEW_PRIVS");
  execvp(argv[9], &argv[9]);
  fail("execvp");
}
