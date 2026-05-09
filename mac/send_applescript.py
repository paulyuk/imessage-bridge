#!/usr/bin/env python3
"""Helper to send an iMessage via osascript. Returns True/False.
"""
import subprocess, shlex

def send(to, text):
    safe = text.replace('"','\\"')
    applescript = f'''tell application "Messages"\n set targetService to 1st service whose service type = iMessage\n set theBuddy to buddy "{to}" of targetService\n send "{safe}" to theBuddy\nend tell'''
    try:
        subprocess.run(['osascript','-e',applescript], check=True)
        return True
    except subprocess.CalledProcessError:
        return False

if __name__=='__main__':
    import sys
    if len(sys.argv)<3:
        print('usage: send_applescript.py "+1425..." "message text"')
        sys.exit(2)
    ok = send(sys.argv[1], sys.argv[2])
    print('ok' if ok else 'failed')
