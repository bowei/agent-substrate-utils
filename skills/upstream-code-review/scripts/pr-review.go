package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
)

const (
	upstreamRepo = "agent-substrate/substrate"
	prJSONFields = "number,title,author,body,baseRefName,headRefName,state,isDraft,labels,additions,deletions,files,commits,reviews,comments"
)

var (
	repoFlag            string
	resolvedPrimaryRepo string
	verifierNameRe      = regexp.MustCompile(`^[a-z0-9_-]+$`)
)

func upstreamRemote() string {
	if r := os.Getenv("SUBSTRATE_UPSTREAM_REMOTE"); r != "" {
		return r
	}
	return "upstream"
}

func callerDir() string {
	if pwd := os.Getenv("PWD"); pwd != "" && filepath.IsAbs(pwd) {
		if info, err := os.Stat(pwd); err == nil && info.IsDir() {
			return pwd
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func resolvePathFromCaller(p string) string {
	if strings.HasPrefix(p, "~/") || p == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			if p == "~" {
				p = home
			} else {
				p = filepath.Join(home, p[2:])
			}
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(callerDir(), p)
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return filepath.Clean(p)
}

func resolvePrimaryRepo(explicitRepo string) (string, error) {
	raw := explicitRepo
	if raw == "" {
		raw = os.Getenv("SUBSTRATE_REPO")
	}

	var candidate string
	if raw != "" {
		candidate = resolvePathFromCaller(raw)
		info, err := os.Stat(candidate)
		if err != nil || !info.IsDir() {
			return "", fmt.Errorf("repo path %q does not exist or is not a directory", candidate)
		}
	} else {
		candidate = callerDir()
	}

	cmd := exec.Command("git", "rev-parse", "--git-common-dir")
	cmd.Dir = candidate
	out, err := cmd.Output()
	commonDirRaw := strings.TrimSpace(string(out))
	if err != nil || commonDirRaw == "" {
		if raw != "" {
			return "", fmt.Errorf("%q is not a git repository", candidate)
		}
		return "", fmt.Errorf(
			"current directory %q is not inside a git checkout; pass --repo <path> (or -C <path>) or run from inside the substrate checkout",
			candidate,
		)
	}

	commonDir := commonDirRaw
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(candidate, commonDir)
	}
	if resolved, err := filepath.EvalSymlinks(commonDir); err == nil {
		commonDir = resolved
	} else {
		commonDir = filepath.Clean(commonDir)
	}

	repoRoot := commonDir
	if filepath.Base(commonDir) == ".git" {
		repoRoot = filepath.Dir(commonDir)
	}

	goModPath := filepath.Join(repoRoot, "go.mod")
	goModBytes, err := os.ReadFile(goModPath)
	if err != nil || !strings.Contains(string(goModBytes), "module github.com/agent-substrate/substrate") {
		return "", fmt.Errorf(
			"%q is not an agent-substrate/substrate checkout; pass --repo <path> (or -C <path>) pointing to the substrate repo",
			repoRoot,
		)
	}

	return repoRoot, nil
}

func primaryRepo() (string, error) {
	if resolvedPrimaryRepo != "" {
		return resolvedPrimaryRepo, nil
	}
	r, err := resolvePrimaryRepo(repoFlag)
	if err != nil {
		return "", err
	}
	resolvedPrimaryRepo = r
	return r, nil
}

func extractLeadingRepoFlags(args []string) (string, []string, error) {
	var repo string
	i := 0
	for i < len(args) {
		arg := args[i]
		if arg == "--repo" || arg == "-C" {
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("%s requires a path argument", arg)
			}
			repo = args[i+1]
			i += 2
		} else if strings.HasPrefix(arg, "--repo=") || strings.HasPrefix(arg, "-C=") {
			parts := strings.SplitN(arg, "=", 2)
			if parts[1] == "" {
				return "", nil, fmt.Errorf("%s requires a path argument", parts[0])
			}
			repo = parts[1]
			i++
		} else {
			break
		}
	}
	return repo, args[i:], nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func normalizePR(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "#")
	if idx := strings.Index(s, "/pull/"); idx != -1 {
		s = s[idx+len("/pull/"):]
		if slash := strings.IndexByte(s, '/'); slash != -1 {
			s = s[:slash]
		}
		if q := strings.IndexByte(s, '?'); q != -1 {
			s = s[:q]
		}
		if hash := strings.IndexByte(s, '#'); hash != -1 {
			s = s[:hash]
		}
	}
	if !isDigits(s) {
		return "", fmt.Errorf("invalid PR identifier %q (expected PR number or GitHub PR URL)", raw)
	}
	return s, nil
}

func popPR(args []string) (string, []string, error) {
	r, rest, err := extractLeadingRepoFlags(args)
	if err != nil {
		return "", nil, err
	}
	if r != "" {
		repoFlag = r
	}
	if len(rest) == 0 {
		return "", nil, errors.New("PR number or URL is required")
	}
	pr, err := normalizePR(rest[0])
	if err != nil {
		return "", nil, err
	}
	return pr, rest[1:], nil
}

func hasHelpFlag(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}

func worktreeDir(pr string) (string, error) {
	repo, err := primaryRepo()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(repo), fmt.Sprintf("pr-review-%s", pr)), nil
}

func clusterName(pr string) string {
	return fmt.Sprintf("pr-review-%s", pr)
}

func kubeContext(pr string) string {
	return fmt.Sprintf("kind-pr-review-%s", pr)
}

func kindEnv(pr string, extra map[string]string) []string {
	env := os.Environ()
	env = append(env,
		"KIND_CLUSTER_NAME="+clusterName(pr),
		"KUBECTL_CONTEXT="+kubeContext(pr),
	)
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}

func runCmd(dir string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if env != nil {
		cmd.Env = env
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func captureCmd(dir string, ignoreStderr bool, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if !ignoreStderr {
		cmd.Stderr = os.Stderr
	}
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

func gitExists(wt string) bool {
	_, err := os.Stat(filepath.Join(wt, ".git"))
	return err == nil
}

func ensureWorktree(pr string) (string, error) {
	wt, err := worktreeDir(pr)
	if err != nil {
		return "", err
	}
	if !gitExists(wt) {
		return setupWorktree(pr)
	}
	return wt, nil
}

func setupWorktree(pr string) (string, error) {
	repo, err := primaryRepo()
	if err != nil {
		return "", err
	}
	wt := filepath.Join(filepath.Dir(repo), fmt.Sprintf("pr-review-%s", pr))
	remote := upstreamRemote()

	fmt.Printf("Fetching %s main and pull/%s/head...\n", remote, pr)
	if err := runCmd(repo, nil, "git", "fetch", remote, "main"); err != nil {
		return "", err
	}
	if err := runCmd(repo, nil, "git", "fetch", remote, fmt.Sprintf("pull/%s/head", pr)); err != nil {
		return "", err
	}
	prHead, err := captureCmd(repo, false, "git", "rev-parse", "FETCH_HEAD")
	if err != nil {
		return "", err
	}

	if gitExists(wt) {
		fmt.Printf("Updating existing worktree at %s to %s...\n", wt, prHead)
		if err := runCmd(wt, nil, "git", "checkout", "--detach", prHead); err != nil {
			return "", err
		}
		if err := runCmd(wt, nil, "git", "reset", "--hard", prHead); err != nil {
			return "", err
		}
		if err := runCmd(wt, nil, "git", "clean", "-fd"); err != nil {
			return "", err
		}
	} else {
		fmt.Printf("Creating detached worktree at %s (%s)...\n", wt, prHead)
		if err := runCmd(repo, nil, "git", "worktree", "prune"); err != nil {
			return "", err
		}
		if err := runCmd(repo, nil, "git", "worktree", "add", "--detach", wt, prHead); err != nil {
			return "", err
		}
	}

	// Symlink cached micro-VM assets from primary checkout if available.
	primaryAssets := filepath.Join(repo, "bin", "microvm-assets")
	wtAssets := filepath.Join(wt, "bin", "microvm-assets")
	if info, err := os.Stat(primaryAssets); err == nil && info.IsDir() {
		if linfo, lerr := os.Lstat(wtAssets); lerr == nil && (linfo.Mode()&os.ModeSymlink != 0) {
			if _, serr := os.Stat(wtAssets); serr != nil {
				_ = os.Remove(wtAssets)
			}
		}
		if _, serr := os.Stat(wtAssets); os.IsNotExist(serr) {
			_ = os.MkdirAll(filepath.Dir(wtAssets), 0o755)
			_ = os.Symlink(primaryAssets, wtAssets)
		}
	}

	fmt.Printf("Worktree ready at: %s\n", wt)
	return wt, nil
}

func kindDown(pr string) error {
	cname := clusterName(pr)
	repo, err := primaryRepo()
	if err != nil {
		return err
	}
	wt := filepath.Join(filepath.Dir(repo), fmt.Sprintf("pr-review-%s", pr))
	repoForKind := repo
	if gitExists(wt) {
		repoForKind = wt
	}
	kindSh := filepath.Join(repoForKind, "hack", "kind.sh")

	fmt.Printf("Deleting Kind cluster '%s'...\n", cname)
	_ = runCmd(repoForKind, nil, kindSh, "delete", "cluster", "--name", cname)

	// Only remove kind-registry if `kind get clusters` succeeds and reports no
	// remaining clusters.
	remaining, err := captureCmd(repoForKind, true, kindSh, "get", "clusters")
	if err != nil {
		return nil
	}
	if remaining == "" {
		createdBy, _ := captureCmd(
			"",
			true,
			"docker",
			"inspect",
			"--format",
			`{{index .Config.Labels "created-by"}}`,
			"kind-registry",
		)
		if createdBy == "agent-substrate" {
			fmt.Println("No Kind clusters remaining; removing 'kind-registry' container...")
			_ = runCmd("", nil, "docker", "rm", "-f", "kind-registry")
		}
	} else {
		fmt.Println("Other Kind clusters still exist; leaving 'kind-registry' running.")
	}
	return nil
}

func newRootCmd() *cobra.Command {
	rootCmd := &cobra.Command{
		Use:           "pr-review",
		Short:         "Helper CLI for the upstream-code-review skill",
		SilenceUsage:  true,
		SilenceErrors: true,
		CompletionOptions: cobra.CompletionOptions{
			DisableDefaultCmd: true,
		},
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if repoFlag != "" {
				_, err := primaryRepo()
				return err
			}
			return nil
		},
	}

	rootCmd.PersistentFlags().StringVarP(
		&repoFlag,
		"repo",
		"C",
		"",
		"Path to the local substrate git checkout (or worktree); defaults to $SUBSTRATE_REPO or current directory",
	)

	// list
	listCmd := &cobra.Command{
		Use:                "list [gh-pr-list-flags...]",
		Short:              "List open PRs on agent-substrate/substrate",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			r, rest, err := extractLeadingRepoFlags(args)
			if err != nil {
				return err
			}
			if r != "" {
				repoFlag = r
				if _, err := primaryRepo(); err != nil {
					return err
				}
			}
			ghArgs := append([]string{"pr", "list", "--repo", upstreamRepo}, rest...)
			return runCmd("", nil, "gh", ghArgs...)
		},
	}

	// info
	infoCmd := &cobra.Command{
		Use:     "info <PR>",
		Aliases: []string{"context"},
		Short:   "Fetch PR metadata, commits, files, reviews, and comments as JSON",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			return runCmd("", nil, "gh", "pr", "view", pr, "--repo", upstreamRepo, "--json", prJSONFields)
		},
	}

	// checks
	checksCmd := &cobra.Command{
		Use:                "checks <PR> [gh-pr-checks-flags...]",
		Short:              "Check CI / GitHub Actions status for <PR>",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			ghArgs := append([]string{"pr", "checks", pr, "--repo", upstreamRepo}, rest...)
			return runCmd("", nil, "gh", ghArgs...)
		},
	}

	// diff
	diffCmd := &cobra.Command{
		Use:                "diff <PR> [gh-pr-diff-flags...]",
		Short:              "Fetch the unified diff for <PR>",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			ghArgs := append([]string{"pr", "diff", pr, "--repo", upstreamRepo}, rest...)
			return runCmd("", nil, "gh", ghArgs...)
		},
	}

	// worktree-setup
	worktreeSetupCmd := &cobra.Command{
		Use:     "worktree-setup <PR>",
		Aliases: []string{"setup"},
		Short:   "Fetch upstream main + pull/<PR>/head and create/update detached worktree",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			_, err = setupWorktree(pr)
			return err
		},
	}

	// fetch-all
	fetchAllCmd := &cobra.Command{
		Use:   "fetch-all <PR>",
		Short: "Run info, checks, and worktree-setup for <PR> in one step",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			if _, err := primaryRepo(); err != nil {
				return err
			}
			fmt.Println("=== PR Metadata ===")
			if err := runCmd("", nil, "gh", "pr", "view", pr, "--repo", upstreamRepo, "--json", prJSONFields); err != nil {
				return err
			}
			fmt.Println("\n=== PR Checks ===")
			if err := runCmd("", nil, "gh", "pr", "checks", pr, "--repo", upstreamRepo); err != nil {
				var exitErr *exec.ExitError
				if errors.As(err, &exitErr) {
					fmt.Printf("(note: gh pr checks exited with status %d)\n", exitErr.ExitCode())
				} else {
					return err
				}
			}
			fmt.Println("\n=== Worktree Setup ===")
			_, err = setupWorktree(pr)
			return err
		},
	}

	// worktree-cleanup
	worktreeCleanupCmd := &cobra.Command{
		Use:     "worktree-cleanup <PR>",
		Aliases: []string{"cleanup"},
		Short:   "Tear down the pr-review-<PR> Kind cluster and remove the git worktree",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			repo, err := primaryRepo()
			if err != nil {
				return err
			}
			wt := filepath.Join(filepath.Dir(repo), fmt.Sprintf("pr-review-%s", pr))
			if err := kindDown(pr); err != nil {
				return err
			}
			if info, statErr := os.Stat(wt); statErr == nil && info.IsDir() {
				fmt.Printf("Removing worktree %s...\n", wt)
				if err := runCmd(repo, nil, "git", "worktree", "remove", "--force", wt); err != nil {
					return err
				}
			}
			if err := runCmd(repo, nil, "git", "worktree", "prune"); err != nil {
				return err
			}
			fmt.Printf("Cleanup complete for PR #%s.\n", pr)
			return nil
		},
	}

	// test
	testCmd := &cobra.Command{
		Use:                "test <PR> [--dir=<subdir>] [go-test-flags-and-pkgs...]",
		Short:              "Run go test inside the PR worktree (defaults to -race ./...)",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			wt, err := ensureWorktree(pr)
			if err != nil {
				return err
			}
			targetDir := wt

			var subdir string
			hasSubdir := false
			if len(rest) > 0 && strings.HasPrefix(rest[0], "--dir=") {
				subdir = strings.SplitN(rest[0], "=", 2)[1]
				rest = rest[1:]
				hasSubdir = true
			} else if len(rest) >= 2 && rest[0] == "--dir" {
				subdir = rest[1]
				rest = rest[2:]
				hasSubdir = true
			}

			if hasSubdir {
				cleaned := filepath.Clean(subdir)
				if subdir == "" || filepath.IsAbs(subdir) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
					return errors.New("--dir must be a relative subdirectory inside the worktree")
				}
				targetDir = filepath.Join(wt, cleaned)
				if info, statErr := os.Stat(targetDir); statErr != nil || !info.IsDir() {
					return fmt.Errorf("directory %q does not exist", targetDir)
				}
			}

			goArgs := rest
			if len(goArgs) == 0 {
				goArgs = []string{"-race", "./..."}
			}
			return runCmd(targetDir, nil, "go", append([]string{"test"}, goArgs...)...)
		},
	}

	// root-test
	rootTestCmd := &cobra.Command{
		Use:                "root-test <PR> [go-test-flags...]",
		Short:              "Run hack/run-root-tests.sh inside the PR worktree",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			wt, err := ensureWorktree(pr)
			if err != nil {
				return err
			}
			testArgs := rest
			if len(testArgs) == 0 {
				testArgs = []string{"-race", "-v"}
			}
			return runCmd(wt, nil, "bash", append([]string{"hack/run-root-tests.sh"}, testArgs...)...)
		},
	}

	// verify
	verifyCmd := &cobra.Command{
		Use:                "verify <PR> [verifier-name] [args...]",
		Short:              "Run hack/verify-all.sh (default) or hack/verify/<verifier-name>.sh",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			wt, err := ensureWorktree(pr)
			if err != nil {
				return err
			}

			if len(rest) == 0 || rest[0] == "all" {
				var extra []string
				if len(rest) > 1 {
					extra = rest[1:]
				}
				return runCmd(wt, nil, "bash", append([]string{"hack/verify-all.sh"}, extra...)...)
			}

			verifier := strings.TrimSuffix(rest[0], ".sh")
			if !verifierNameRe.MatchString(verifier) {
				return fmt.Errorf("invalid verifier name %q", verifier)
			}
			script := filepath.Join(wt, "hack", "verify", verifier+".sh")
			if info, statErr := os.Stat(script); statErr != nil || info.IsDir() {
				return fmt.Errorf("verifier script %q not found", script)
			}
			return runCmd(wt, nil, "bash", append([]string{script}, rest[1:]...)...)
		},
	}

	// kind-up
	var (
		withCSINFS      bool
		withDemoCounter bool
		withDemoEgress  bool
		withMicroVM     bool
		skipInstall     bool
	)
	kindUpCmd := &cobra.Command{
		Use:   "kind-up <PR>",
		Short: "Create an isolated Kind cluster named pr-review-<PR> and install Agent Substrate",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			wt, err := ensureWorktree(pr)
			if err != nil {
				return err
			}
			env := kindEnv(pr, nil)

			if err := runCmd(wt, env, "bash", "hack/create-kind-cluster.sh"); err != nil {
				return err
			}
			if skipInstall {
				fmt.Printf("Cluster '%s' created (--skip-install set).\n", clusterName(pr))
				return nil
			}

			installFlags := []string{"hack/install-ate-kind.sh", "--deploy-ate-system"}
			if withCSINFS {
				installFlags = append(installFlags, "--setup-csi=nfs")
			}
			if err := runCmd(wt, env, "bash", installFlags...); err != nil {
				return err
			}

			if withMicroVM {
				bucket := os.Getenv("BUCKET_NAME")
				if bucket == "" {
					bucket = "ate-snapshots"
				}
				microvmEnv := kindEnv(pr, map[string]string{
					"NO_DEV_ENV":       "true",
					"ATE_INSTALL_KIND": "true",
					"BUCKET_NAME":      bucket,
				})
				if err := runCmd(wt, microvmEnv, "bash", "hack/install-microvm-deps.sh", "--install"); err != nil {
					return err
				}
			}

			if withDemoCounter {
				if err := runCmd(wt, env, "bash", "hack/install-ate-kind.sh", "--deploy-demo-counter"); err != nil {
					return err
				}
				if withMicroVM {
					if err := runCmd(wt, env, "bash", "hack/install-ate-kind.sh", "--deploy-demo-counter-microvm"); err != nil {
						return err
					}
				}
			}

			if withDemoEgress {
				if err := runCmd(wt, env, "bash", "hack/install-ate-kind.sh", "--deploy-demo-egress"); err != nil {
					return err
				}
				if withMicroVM {
					if err := runCmd(wt, env, "bash", "hack/install-ate-kind.sh", "--deploy-demo-egress-microvm"); err != nil {
						return err
					}
				}
			}

			return nil
		},
	}
	kindUpCmd.Flags().BoolVar(&withCSINFS, "with-csi-nfs", false, "Set up NFS CSI driver")
	kindUpCmd.Flags().BoolVar(&withDemoCounter, "with-demo-counter", false, "Deploy demo-counter fixture")
	kindUpCmd.Flags().BoolVar(&withDemoEgress, "with-demo-egress", false, "Deploy demo-egress fixture")
	kindUpCmd.Flags().BoolVar(&withMicroVM, "with-microvm", false, "Install micro-VM dependencies and fixtures")
	kindUpCmd.Flags().BoolVar(&skipInstall, "skip-install", false, "Only create the Kind cluster without installing Agent Substrate")

	// kind-install
	kindInstallCmd := &cobra.Command{
		Use:                "kind-install <PR> <install-ate-kind-flags...>",
		Short:              "Run hack/install-ate-kind.sh against the pr-review-<PR> cluster",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			wt, err := ensureWorktree(pr)
			if err != nil {
				return err
			}
			return runCmd(wt, kindEnv(pr, nil), "bash", append([]string{"hack/install-ate-kind.sh"}, rest...)...)
		},
	}

	// kind-e2e
	kindE2ECmd := &cobra.Command{
		Use:                "kind-e2e <PR> [--microvm] [--egress-mitm] [run-e2e-kind-args...]",
		Short:              "Run hack/run-e2e-kind.sh against the pr-review-<PR> cluster",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			wt, err := ensureWorktree(pr)
			if err != nil {
				return err
			}

			extraEnv := map[string]string{}
			remaining := rest
			for len(remaining) > 0 && (remaining[0] == "--microvm" || remaining[0] == "--egress-mitm") {
				flag := remaining[0]
				remaining = remaining[1:]
				if flag == "--microvm" {
					extraEnv["E2E_SANDBOX_CLASS"] = "microvm"
				} else if flag == "--egress-mitm" {
					extraEnv["E2E_EGRESS_MITM"] = "1"
				}
			}

			e2eArgs := remaining
			if len(e2eArgs) == 0 {
				e2eArgs = []string{"-v", "-args", "--no-color"}
			}
			return runCmd(wt, kindEnv(pr, extraEnv), "bash", append([]string{"hack/run-e2e-kind.sh"}, e2eArgs...)...)
		},
	}

	// kind-kubectl
	kindKubectlCmd := &cobra.Command{
		Use:                "kind-kubectl <PR> <kubectl-args...>",
		Short:              "Run kubectl targeting context kind-pr-review-<PR>",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if hasHelpFlag(args) {
				return cmd.Help()
			}
			pr, rest, err := popPR(args)
			if err != nil {
				return err
			}
			kArgs := append([]string{"--context=" + kubeContext(pr)}, rest...)
			return runCmd("", nil, "kubectl", kArgs...)
		},
	}

	// kind-logs
	kindLogsCmd := &cobra.Command{
		Use:   "kind-logs <PR>",
		Short: "Dump pod statuses, ate-system logs, and worker-pool logs for pr-review-<PR>",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			ctx := kubeContext(pr)

			_ = runCmd("", nil, "kubectl", "--context", ctx, "get", "workerpool,pods", "-A", "-o", "wide")

			dumpPod := func(ns, pod string) {
				fmt.Printf("=== logs: %s/%s ===\n", ns, pod)
				_ = runCmd("", nil, "kubectl", "--context", ctx, "logs", "-n", ns, pod, "--all-containers", "--tail=300")
			}

			atePods, _ := captureCmd("", true, "kubectl", "--context", ctx, "get", "pods", "-n", "ate-system", "-o", "name")
			for _, pod := range strings.Split(atePods, "\n") {
				pod = strings.TrimSpace(pod)
				if pod != "" {
					dumpPod("ate-system", pod)
				}
			}

			workerPods, _ := captureCmd(
				"",
				true,
				"kubectl",
				"--context",
				ctx,
				"get",
				"pods",
				"-A",
				"-l",
				"ate.dev/worker-pool",
				"-o",
				"custom-columns=:.metadata.namespace,:.metadata.name",
				"--no-headers",
			)
			for _, line := range strings.Split(workerPods, "\n") {
				parts := strings.Fields(line)
				if len(parts) == 2 {
					dumpPod(parts[0], parts[1])
				}
			}
			return nil
		},
	}

	// kind-down
	kindDownCmd := &cobra.Command{
		Use:   "kind-down <PR>",
		Short: "Delete the pr-review-<PR> Kind cluster",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pr, err := normalizePR(args[0])
			if err != nil {
				return err
			}
			return kindDown(pr)
		},
	}

	rootCmd.AddCommand(
		listCmd,
		infoCmd,
		checksCmd,
		diffCmd,
		worktreeSetupCmd,
		fetchAllCmd,
		worktreeCleanupCmd,
		testCmd,
		rootTestCmd,
		verifyCmd,
		kindUpCmd,
		kindInstallCmd,
		kindE2ECmd,
		kindKubectlCmd,
		kindLogsCmd,
		kindDownCmd,
	)

	return rootCmd
}

func main() {
	rootCmd := newRootCmd()

	// Extract leading --repo / -C flags before subcommand so subcommands with
	// DisableFlagParsing: true also honor top-level --repo / -C flags.
	r, remaining, err := extractLeadingRepoFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(2)
	}
	if r != "" {
		repoFlag = r
		if _, err := primaryRepo(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	}
	rootCmd.SetArgs(remaining)

	if err := rootCmd.Execute(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
