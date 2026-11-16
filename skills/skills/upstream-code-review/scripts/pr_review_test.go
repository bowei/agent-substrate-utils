package main

import (
	"reflect"
	"testing"
)

func TestNormalizePR(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "123", want: "123"},
		{in: "#456", want: "456"},
		{in: "https://github.com/agent-substrate/substrate/pull/789", want: "789"},
		{in: "https://github.com/agent-substrate/substrate/pull/789/files?w=1#diff-abc", want: "789"},
		{in: "", wantErr: true},
		{in: "abc", wantErr: true},
	}

	for _, tc := range tests {
		got, err := normalizePR(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("normalizePR(%q) succeeded with %q; want error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizePR(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("normalizePR(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}

func TestExtractLeadingRepoFlags(t *testing.T) {
	repo, rest, err := extractLeadingRepoFlags([]string{"--repo", "/tmp/repo", "fetch-all", "123"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo != "/tmp/repo" {
		t.Errorf("repo = %q; want /tmp/repo", repo)
	}
	if !reflect.DeepEqual(rest, []string{"fetch-all", "123"}) {
		t.Errorf("rest = %v; want [fetch-all 123]", rest)
	}

	repo, rest, err = extractLeadingRepoFlags([]string{"-C=/tmp/repo2", "test", "123", "-race"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo != "/tmp/repo2" {
		t.Errorf("repo = %q; want /tmp/repo2", repo)
	}
	if !reflect.DeepEqual(rest, []string{"test", "123", "-race"}) {
		t.Errorf("rest = %v; want [test 123 -race]", rest)
	}
}
