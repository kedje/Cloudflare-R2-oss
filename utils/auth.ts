export function get_auth_status_for_path(context, dopath: string) {
    if(context.env["GUEST"]){
        if(dopath.startsWith("_$flaredrive$/thumbnails/"))return true;
        const allow_guest = context.env["GUEST"].split(",")
        for (var aa of allow_guest){
            if(aa == "*"){
                return true
            }else if(dopath.startsWith(aa)){
                return true
            }
        }
    }
    var headers = new Headers(context.request.headers);
    if(!headers.get('Authorization'))return false
    const Authorization=headers.get('Authorization').split("Basic ")[1]
    const account = atob(Authorization);
    if(!account)return false
    if(!context.env[account])return false
    if(dopath.startsWith("_$flaredrive$/thumbnails/"))return true;
    const allow = context.env[account].split(",")
    for (var a of allow){
        if(a == "*"){
            return true
        }else if(dopath.startsWith(a)){
            return true
        }
    }
    return false;
  }

export function get_auth_status(context) {
    const marker = "/api/write/items/";
    const path = context.request.url.split(marker)[1] || "";
    return get_auth_status_for_path(context, path);
  }
