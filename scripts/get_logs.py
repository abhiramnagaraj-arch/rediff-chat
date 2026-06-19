import subprocess

def get_logs():
    try:
        result = subprocess.run(
            ['docker', 'compose', 'logs', '--tail=100', 'rediff_ejabberd_a', 'rediff_ejabberd_b', 'rediff_ejabberd_c'],
            cwd='/home/abhiram.nagaraj/Downloads/Edjabberd',
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        print("STDOUT:")
        print(result.stdout)
        print("STDERR:")
        print(result.stderr)
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    get_logs()
