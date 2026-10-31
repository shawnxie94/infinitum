from pathlib import Path

root = Path(__import__('os').environ.get('WERSS_SOURCE_ROOT', '/app'))
# The selected upstream revision sends login details to webhooks. Disable all
# outbound notices in this isolated deployment, including auth notifications.
notice = root / 'jobs/notice.py'
if 'def sys_notice(' not in notice.read_text():
    raise RuntimeError('unexpected WeRSS notification implementation')
notice.write_text('def sys_notice(text="", title="", tag="", type=""):\n    return None\n')

replacements = {
    'driver/success.py': [
        ("                Success_Msg(data,ext_data)", "                # Authentication notifications disabled."),
        ("                print_success(f\"有效时间: {data['expiry']['expiry_time']} (剩余秒数: {data['expiry']['remaining_seconds']}) Token: {data['token']}\")", "                print_success('微信授权成功')"),
    ],
    'driver/token.py': [("    print_success(f\"Token:{data.get('token')} \\n到期时间:{data.get('expiry')['expiry_time']}\\n\")", "    print_success('微信授权已保存')")],
    'driver/wx_api.py': [
        ('            print(self.cookies)', '            # Do not log cookies.'),
        ('                print(f"token: {token}")', '                # Do not log tokens.'),
        ("        print(f\"Token: {session_data.get('token')}\")", '        # Do not log tokens.'),
    ],
    'driver/wx.py': [("                print_success(f\"已更新Token: {self.SESSION.get('token')}\")", "                print_success('微信授权已更新')")],
    'apis/auth.py': [("            print(f\"Token: {data['token']}\")", "            # Do not log tokens.")],
}
for filename, rules in replacements.items():
    path = root / filename
    content = path.read_text()
    for old, new in rules:
        if content.count(old) != 1:
            raise RuntimeError(f'unexpected WeRSS source: {filename}')
        content = content.replace(old, new)
    path.write_text(content)
